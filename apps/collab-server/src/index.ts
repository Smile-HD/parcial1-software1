/**
 * @app/collab-server — Yjs collaboration transport (PR 5, design D4).
 *
 * One room per diagram: clients connect to ws://host:port/diagrams/<diagramId>.
 * The sync/awareness wire protocol is implemented directly on top of
 * y-protocols using the SAME ESM yjs instance as @app/core and the persistence
 * binding. Do NOT route room docs through `y-websocket/bin/utils`: its
 * `require('yjs')` resolves a second (CJS) yjs instance, and a room doc
 * bootstrapped across the two copies mis-integrates client deltas (the
 * "vanishing key" bug found in PR 5 verification). One copy everywhere.
 *
 * Persistence binding invariants (design.md "Persistence Schema"):
 * - The Yjs blob (yjs_state) is authoritative; room open loads it.
 * - Saves are debounced and guarded by optimistic version checks.
 * - The transport never becomes a second source of truth.
 */
import { Buffer } from 'node:buffer';
import { createServer, type Server as HttpServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage } from 'node:http';
import { WebSocket as WsWebSocket, WebSocketServer, type RawData } from 'ws';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { PgPersistence, diagramIdFromRoom } from './persistence.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

interface Room {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  /** conn → awareness client ids announced by that conn */
  readonly conns: Map<WsWebSocket, Set<number>>;
}

export interface CollabServerOptions {
  /** 0 = ephemeral port (tests). Default 1234. */
  port?: number;
  /** Default 127.0.0.1; use 0.0.0.0 for LAN. */
  host?: string;
  databaseUrl: string;
  /** Debounce window for room persistence. Default 500ms. */
  debounceMs?: number;
}

export interface CollabServer {
  readonly port: number;
  /** Resolves when no debounced or in-flight persistence write remains. */
  idle(): Promise<void>;
  /** Resolves once the server has scheduled (or started) at least one write. Test timing aid. */
  waitUntilScheduled(timeoutMs?: number): Promise<void>;
  /** Closes sockets, flushes rooms, shuts down HTTP + pool. Idempotent. */
  close(): Promise<void>;
}

function toUint8Array(data: RawData): Uint8Array {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(Buffer.concat(data as Buffer[]));
}

function send(conn: WsWebSocket, message: Uint8Array): void {
  if (conn.readyState === WsWebSocket.OPEN) void conn.send(message);
}

export async function startCollabServer(options: CollabServerOptions): Promise<CollabServer> {
  const persistence = new PgPersistence({
    databaseUrl: options.databaseUrl,
    debounceMs: options.debounceMs,
  });

  const rooms = new Map<string, Room>();

  const getOrCreateRoom = (docName: string): Room => {
    const existing = rooms.get(docName);
    if (existing) return existing;
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null); // the server holds no local awareness state
    const room: Room = { doc, awareness, conns: new Map() };
    rooms.set(docName, room);
    // Awareness changes: track which clients each conn introduced (for cleanup
    // on disconnect) and relay every add/update/removal to all conns. This
    // event-driven relay is REQUIRED: y-protocols 1.0.7 `applyAwarenessUpdate`
    // returns void, and removals (removeAwarenessStates) never travel as raw
    // client messages — clients only learn about a departed peer through here.
    awareness.on('update', (change: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...change.added, ...change.updated, ...change.removed];
      if (origin instanceof WsWebSocket) {
        const tracked = room.conns.get(origin);
        if (tracked) for (const clientId of changed) tracked.add(clientId);
      }
      if (changed.length === 0 || room.conns.size === 0) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed));
      const message = encoding.toUint8Array(encoder);
      for (const conn of room.conns.keys()) send(conn, message);
    });
    // Blob-authoritative bootstrap: load persisted state once per room (design D4).
    void persistence.bindState(docName, doc).catch((error: unknown) => {
      console.error(`[collab-server] persistence binding failed for room ${docName}`, error);
    });
    // Broadcast doc updates to every connected client, INCLUDING the origin one:
    // clients re-applying their own update is a no-op for Yjs, and the echo is
    // the ack that the server integrated the change (mirrors y-websocket utils).
    doc.on('update', (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const conn of room.conns.keys()) {
        send(conn, message);
      }
    });
    return room;
  };

  const messageListener = (room: Room, conn: WsWebSocket, message: Uint8Array): void => {
    const decoder = decoding.createDecoder(message);
    const messageType = decoding.readVarUint(decoder);
    const encoder = encoding.createEncoder();
    switch (messageType) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, room.doc, conn);
        if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS: {
        // y-protocols 1.0.7 applyAwarenessUpdate returns void: per-conn
        // tracking and the relay to the other clients happen in the room's
        // awareness 'update' handler (origin is this conn).
        awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), conn);
        break;
      }
      default:
        break;
    }
  };

  const httpServer: HttpServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('ai-uml collab-server');
  });

  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (conn: WsWebSocket, request: IncomingMessage) => {
    const docName = (request.url || '').slice(1).split('?')[0];
    let room: Room;
    try {
      room = getOrCreateRoom(docName);
      room.conns.set(conn, new Set());

      // Hand the newcomer the current awareness states and a sync step 1 so it
      // replies with its diff (mirrors y-websocket's connection setup).
      const states = room.awareness.getStates();
      if (states.size > 0) {
        const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(room.awareness, Array.from(states.keys()));
        const awarenessEncoder = encoding.createEncoder();
        encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(awarenessEncoder, awarenessUpdate);
        send(conn, encoding.toUint8Array(awarenessEncoder));
      }
      const syncEncoder = encoding.createEncoder();
      encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
      syncProtocol.writeSyncStep1(syncEncoder, room.doc);
      send(conn, encoding.toUint8Array(syncEncoder));
    } catch (error) {
      // Setup must never throw into the upgrade gate's promise chain (it would
      // surface as a bogus "room bootstrap failed"); fail the conn instead.
      console.error('[collab-server] connection setup failed', error);
      conn.close();
      return;
    }

    conn.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      try {
        messageListener(room, conn, toUint8Array(data));
      } catch (error) {
        console.error('[collab-server] message handling failed', error);
      }
    });

    const onDisconnect = (): void => {
      const tracked = room.conns.get(conn);
      if (!tracked) return; // already disconnected (close fires after error)
      room.conns.delete(conn);
      if (tracked.size > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(tracked), null);
      }
      if (room.conns.size === 0) {
        rooms.delete(docName);
        // Last connection left the room: flush immediately (blob-authoritative).
        void persistence.writeState(docName, room.doc).catch((error: unknown) => {
          console.error(`[collab-server] room flush failed for ${docName}`, error);
        });
      }
    };
    conn.on('close', onDisconnect);
    conn.on('error', onDisconnect);
  });

  // Gate: hold the handshake until the room's persisted blob is fully applied.
  // No client may sync against a room doc that is still bootstrapping.
  httpServer.on('upgrade', (request, socket, head) => {
    const docName = (request.url || '').slice(1).split('?')[0];
    getOrCreateRoom(docName); // starts the persistence bootstrap if needed
    void persistence
      .whenLoaded(docName)
      .then(() => {
        wss.handleUpgrade(request, socket, head, (conn) => {
          wss.emit('connection', conn, request);
        });
      })
      .catch((error: unknown) => {
        console.error(`[collab-server] room bootstrap failed for ${docName}, destroying socket`, error);
        socket.destroy();
      });
  });

  const host = options.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 1234, host, () => resolve());
  });
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : (options.port ?? 1234);

  let closing = false;
  const server: CollabServer = {
    port,
    idle: () => persistence.idle(),
    async waitUntilScheduled(timeoutMs = 5000): Promise<void> {
      const start = Date.now();
      while (persistence.pendingCount() === 0) {
        if (Date.now() - start > timeoutMs) {
          throw new Error(`waitUntilScheduled timeout after ${timeoutMs}ms`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const room of rooms.values()) {
        for (const conn of room.conns.keys()) conn.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 100)); // let close events propagate
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await persistence.destroy();
    },
  };
  return server;
}

// ---------- CLI entry point ----------

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  // Same dev default as the API (postgres:16 in Docker via compose, port 5433).
  // DATABASE_URL overrides for LAN/AWS deployments.
  const databaseUrl = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5433/ai_uml';
  const port = Number(process.env.COLLAB_PORT) || 1234;
  const host = process.env.COLLAB_HOST || '0.0.0.0';
  startCollabServer({ port, host, databaseUrl })
    .then((server) => console.log(`collab-server listening on ws://${host}:${server.port}`))
    .catch((error: unknown) => {
      console.error('Failed to start collab-server:', error);
      process.exit(1);
    });
}
