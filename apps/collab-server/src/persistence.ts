/**
 * PostgreSQL persistence binding for the collab-server.
 *
 * Implements the design invariants from design.md "Persistence Schema":
 * - The Yjs blob (`yjs_state`) is authoritative; room open loads it.
 * - Saves are DEBOUNCED and write `doc` + `yjs_state` + `version` with an
 *   optimistic `UPDATE ... WHERE id = $1 AND version = $2` guard; on conflict
 *   the writer re-reads and retries (the in-memory room state always wins).
 * - `doc` is a write-time projection of the Y.Doc via the shared core codec —
 *   the transport never becomes a second source of truth.
 */
import { Pool } from 'pg';
import * as Y from 'yjs';
import { encodeYDoc, projectYDocToDiagram, type Diagram } from '@app/core';

/** Updates applied by this loader itself must never trigger a persist (no phantom version bumps). */
const LOAD_ORIGIN = 'collab-persistence-load';
const MAX_PERSIST_RETRIES = 5;

export interface PgPersistenceOptions {
  databaseUrl: string;
  debounceMs?: number;
  maxConnections?: number;
}

interface ScheduledWrite {
  timer: NodeJS.Timeout;
  run: () => Promise<void>;
}

export class PgPersistence {
  private readonly pool: Pool;
  private readonly debounceMs: number;
  private readonly scheduled = new Map<string, ScheduledWrite>();
  private readonly inflight = new Set<Promise<void>>();
  /** Room bootstrap promises: resolve when the room's blob is fully applied. */
  private readonly loads = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: PgPersistenceOptions) {
    this.pool = new Pool({ connectionString: options.databaseUrl, max: options.maxConnections ?? 5 });
    this.debounceMs = options.debounceMs ?? 500;
  }

  /**
   * Room open (called by y-websocket utils once per room):
   * 1. attach the debounced update watcher FIRST so early client edits are never lost,
   * 2. load the authoritative blob and apply it with LOAD_ORIGIN.
   */
  async bindState(docName: string, ydoc: Y.Doc): Promise<void> {
    const load = this.loadRoom(docName, ydoc);
    this.loads.set(docName, load);
    void load.finally(() => this.loads.delete(docName));
    await load;
  }

  /**
   * Resolves once the room's persisted blob has been fully applied to its doc.
   * Gate for the WebSocket upgrade handshake: no client syncs against a room
   * whose bootstrap is still in flight (y-websocket calls bindState fire-and-forget).
   */
  whenLoaded(docName: string): Promise<void> {
    return this.loads.get(docName) ?? Promise.resolve();
  }

  private async loadRoom(docName: string, ydoc: Y.Doc): Promise<void> {
    const diagramId = diagramIdFromRoom(docName);
    ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === LOAD_ORIGIN) return;
      this.schedulePersist(docName, ydoc);
    });

    const result = await this.pool.query('SELECT yjs_state FROM diagrams WHERE id = $1', [diagramId]);
    const blob = result.rows[0]?.yjs_state as Buffer | undefined;
    if (blob) {
      Y.applyUpdate(ydoc, new Uint8Array(blob), LOAD_ORIGIN);
    }
  }

  /** Last connection left the room (called by y-websocket utils): flush immediately. */
  async writeState(docName: string, ydoc: Y.Doc): Promise<void> {
    this.clearScheduled(docName);
    await this.track(this.persistRoom(docName, ydoc));
  }

  /**
   * Resolves when no debounced or in-flight write remains.
   * Test/teardown aid: drains scheduled timers and in-flight writes.
   */
  async idle(): Promise<void> {
    for (const [docName, entry] of [...this.scheduled]) {
      this.clearScheduled(docName);
      await this.track(entry.run());
    }
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight]);
    }
  }

  /** Number of writes scheduled or in flight right now. Test aid for timing. */
  pendingCount(): number {
    return this.scheduled.size + this.inflight.size;
  }

  async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.idle();
    await this.pool.end();
  }

  private track(promise: Promise<void>): Promise<void> {
    const tracked = promise.catch((error: unknown) => {
      console.error('[collab-persistence] write failed:', error);
    });
    this.inflight.add(tracked);
    void tracked.finally(() => this.inflight.delete(tracked));
    return promise;
  }

  private clearScheduled(docName: string): void {
    const entry = this.scheduled.get(docName);
    if (entry) {
      clearTimeout(entry.timer);
      this.scheduled.delete(docName);
    }
  }

  private schedulePersist(docName: string, ydoc: Y.Doc): void {
    if (this.closed) return;
    this.clearScheduled(docName);
    const run = () => this.persistRoom(docName, ydoc);
    const timer = setTimeout(() => {
      this.scheduled.delete(docName);
      void this.track(run());
    }, this.debounceMs);
    this.scheduled.set(docName, { timer, run });
  }

  private async persistRoom(docName: string, ydoc: Y.Doc): Promise<void> {
    if (this.closed) return;
    const diagramId = diagramIdFromRoom(docName);

    let diagram: Diagram;
    try {
      diagram = projectYDocToDiagram(ydoc);
    } catch (error) {
      console.error(`[collab-persistence] projection invalid for room ${docName}, skipping write`, error);
      return;
    }
    const doc = JSON.stringify(diagram);
    const yjsState = Buffer.from(encodeYDoc(ydoc));

    for (let attempt = 0; attempt < MAX_PERSIST_RETRIES; attempt++) {
      const current = await this.pool.query('SELECT version, yjs_state FROM diagrams WHERE id = $1', [diagramId]);
      if (current.rows.length === 0) {
        // Orphan room (no API-created row yet): create it lazily.
        await this.pool.query(
          'INSERT INTO diagrams (id, name, doc, yjs_state, version) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING',
          [diagramId, 'Untitled diagram', doc, yjsState],
        );
        return;
      }
      // Content unchanged since the stored blob (e.g. disconnect flush on a
      // read-only room): skip the write so open/close never bumps the version.
      if ((current.rows[0].yjs_state as Buffer).equals(yjsState)) return;
      const expected = current.rows[0].version as number;
      const updated = await this.pool.query(
        'UPDATE diagrams SET doc = $2, yjs_state = $3, version = version + 1, updated_at = now() WHERE id = $1 AND version = $4',
        [diagramId, doc, yjsState, expected],
      );
      if ((updated.rowCount ?? 0) > 0) return; // dual write landed atomically
    }
    throw new Error(`persistRoom: gave up after ${MAX_PERSIST_RETRIES} optimistic retries (diagram ${diagramId})`);
  }
}

/** Room names are `diagrams/<diagramId>` (or a bare id); extract the diagram id. */
export function diagramIdFromRoom(docName: string): string {
  const last = docName.split('/').pop() ?? docName;
  return decodeURIComponent(last);
}
