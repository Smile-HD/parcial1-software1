/**
 * @app/collab-server — Transporte de colaboración Yjs (PR 5, diseño D4).
 *
 * Una sala por diagrama: los clientes se conectan a ws://host:port/diagrams/<diagramId>.
 * El protocolo de red de sincronización/presencia (awareness) está implementado directamente
 * sobre y-protocols usando la MISMA instancia ESM de yjs que @app/core y la vinculación
 * de persistencia. NO enrutar documentos de sala a través de `y-websocket/bin/utils`: su
 * `require('yjs')` resuelve una segunda instancia (CJS) de yjs, y un documento de sala
 * arrancado entre las dos copias desintegra los deltas de los clientes (el error de "llave que desaparece"
 * encontrado en la verificación de PR 5). Una sola copia en todas partes.
 *
 * Invariantes de vinculación de persistencia (design.md "Esquema de Persistencia"):
 * - El blob de Yjs (yjs_state) es autoritativo; la apertura de sala lo carga.
 * - Los guardados son antirrebote y están protegidos por comprobaciones de versión optimistas.
 * - El transporte nunca se convierte en una segunda fuente de verdad.
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
  /** conn → IDs de cliente de presencia (awareness) anunciados por esa conexión */
  readonly conns: Map<WsWebSocket, Set<number>>;
}

export interface CollabServerOptions {
  /** 0 = puerto efímero (pruebas). Por defecto 1234. */
  port?: number;
  /** Por defecto 127.0.0.1; usar 0.0.0.0 para LAN. */
  host?: string;
  databaseUrl: string;
  /** Ventana de antirrebote para la persistencia de sala. Por defecto 500ms. */
  debounceMs?: number;
}

export interface CollabServer {
  readonly port: number;
  /** Se resuelve cuando no quedan escrituras de persistencia antirrebote ni en vuelo. */
  idle(): Promise<void>;
  /** Se resuelve una vez que el servidor ha programado (o iniciado) al menos una escritura. Ayuda de sincronización para pruebas. */
  waitUntilScheduled(timeoutMs?: number): Promise<void>;
  /** Cierra sockets, vacía salas, apaga HTTP + pool. Idempotente. */
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
    awareness.setLocalState(null); // el servidor no mantiene estado local de presencia (awareness)
    const room: Room = { doc, awareness, conns: new Map() };
    rooms.set(docName, room);
    // Cambios de presencia: rastrea qué clientes introdujo cada conexión (para limpieza
    // al desconectar) y retransmite cada adición/actualización/eliminación a todas las conexiones.
    // Esta retransmisión dirigida por eventos es OBLIGATORIA: `applyAwarenessUpdate` de y-protocols 1.0.7
    // retorna void, y las eliminaciones (removeAwarenessStates) nunca viajan como mensajes
    // crudos de cliente — los clientes solo se enteran de un par desconectado a través de aquí.
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
    // Arranque autoritativo por blob: carga el estado persistido una vez por sala (diseño D4).
    void persistence.bindState(docName, doc).catch((error: unknown) => {
      console.error(`[collab-server] persistence binding failed for room ${docName}`, error);
    });
    // Difunde actualizaciones del doc a cada cliente conectado, INCLUYENDO el de origen:
    // que los clientes reapliquen su propia actualización es una operación nula para Yjs, y el eco
    // es la confirmación (ack) de que el servidor integró el cambio (imita y-websocket utils).
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
        // applyAwarenessUpdate de y-protocols 1.0.7 retorna void: el rastreo por
        // conexión y la retransmisión a otros clientes ocurren en el manejador
        // 'update' de awareness de la sala (el origen es esta conexión).
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

      // Entrega al nuevo cliente los estados actuales de presencia y un sync step 1 para que
      // responda con su diff (imita la configuración de conexión de y-websocket).
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
      // La configuración nunca debe lanzar errores a la cadena de promesas de la compuerta de actualización
      // (se manifestaría como un error ficticio de "arranque de sala fallido"); se cierra la conexión en su lugar.
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
      if (!tracked) return; // ya desconectado (close se dispara tras error)
      room.conns.delete(conn);
      if (tracked.size > 0) {
        awarenessProtocol.removeAwarenessStates(room.awareness, Array.from(tracked), null);
      }
      if (room.conns.size === 0) {
        rooms.delete(docName);
        // La última conexión abandonó la sala: vaciar inmediatamente (blob autoritativo).
        void persistence.writeState(docName, room.doc).catch((error: unknown) => {
          console.error(`[collab-server] room flush failed for ${docName}`, error);
        });
      }
    };
    conn.on('close', onDisconnect);
    conn.on('error', onDisconnect);
  });

  // Compuerta: retiene el handshake hasta que el blob persistido de la sala se aplique completamente.
  // Ningún cliente puede sincronizarse contra el doc de una sala que aún se está iniciando.
  httpServer.on('upgrade', (request, socket, head) => {
    const docName = (request.url || '').slice(1).split('?')[0];
    getOrCreateRoom(docName); // inicia el arranque de persistencia si es necesario
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
      await new Promise((resolve) => setTimeout(resolve, 100)); // permite propagar los eventos de cierre
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await persistence.destroy();
    },
  };
  return server;
}

// ---------- Punto de entrada CLI ----------

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  // Mismo valor por defecto de desarrollo que la API (postgres:16 en Docker vía compose, puerto 5433).
  // DATABASE_URL sobreescribe para despliegues en LAN/AWS.
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
