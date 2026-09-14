/**
 * Vinculación de persistencia PostgreSQL para collab-server.
 *
 * Implementa los invariantes de diseño de design.md "Esquema de Persistencia":
 * - El blob de Yjs (`yjs_state`) es autoritativo; la apertura de sala lo carga.
 * - Los guardados son ANTIRREBOTE (debounced) y escriben `doc` + `yjs_state` + `version`
 *   con una guarda optimista `UPDATE ... WHERE id = $1 AND version = $2`; ante un conflicto
 *   el escritor re-lee y reintenta (el estado de sala en memoria siempre gana).
 * - `doc` es una proyección en tiempo de escritura del Y.Doc vía el codec de core compartido —
 *   el transporte nunca se convierte en una segunda fuente de verdad.
 */
import { Pool } from 'pg';
import * as Y from 'yjs';
import { encodeYDoc, projectYDocToDiagram, type Diagram } from '@app/core';

/** Las actualizaciones aplicadas por este cargador nunca deben disparar una persistencia (sin aumentos de versión fantasma). */
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
  /** Promesas de arranque de sala: se resuelven cuando el blob de la sala se aplica completamente. */
  private readonly loads = new Map<string, Promise<void>>();
  private closed = false;

  constructor(options: PgPersistenceOptions) {
    this.pool = new Pool({ connectionString: options.databaseUrl, max: options.maxConnections ?? 5 });
    this.debounceMs = options.debounceMs ?? 500;
  }

  /**
   * Apertura de sala (llamada por y-websocket utils una vez por sala):
   * 1. adjunta PRIMERO el observador de actualizaciones antirrebote para no perder ediciones tempranas de clientes,
   * 2. carga el blob autoritativo y lo aplica con LOAD_ORIGIN.
   */
  async bindState(docName: string, ydoc: Y.Doc): Promise<void> {
    const load = this.loadRoom(docName, ydoc);
    this.loads.set(docName, load);
    void load.finally(() => this.loads.delete(docName));
    await load;
  }

  /**
   * Se resuelve una vez que el blob persistido de la sala se ha aplicado por completo a su doc.
   * Compuerta para el handshake de actualización a WebSocket: ningún cliente se sincroniza contra una sala
   * cuyo arranque todavía esté en curso (y-websocket llama a bindState de forma no bloqueante).
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

  /** La última conexión abandonó la sala (llamado por y-websocket utils): vaciar (flush) inmediatamente. */
  async writeState(docName: string, ydoc: Y.Doc): Promise<void> {
    this.clearScheduled(docName);
    await this.track(this.persistRoom(docName, ydoc));
  }

  /**
   * Se resuelve cuando no quedan escrituras antirrebote ni en vuelo.
   * Ayuda para pruebas/desmontaje: drena temporizadores programados y escrituras en curso.
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

  /** Número de escrituras programadas o en vuelo en este momento. Ayuda de pruebas para sincronización. */
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
        // Sala huérfana (aún sin fila creada por API): crearla de forma perezosa.
        await this.pool.query(
          'INSERT INTO diagrams (id, name, doc, yjs_state, version) VALUES ($1, $2, $3, $4, 1) ON CONFLICT (id) DO NOTHING',
          [diagramId, 'Untitled diagram', doc, yjsState],
        );
        return;
      }
      // Contenido sin cambios desde el blob almacenado (ej. vaciado por desconexión en una
      // sala de solo lectura): omite la escritura para que abrir/cerrar nunca aumente la versión.
      if ((current.rows[0].yjs_state as Buffer).equals(yjsState)) return;
      const expected = current.rows[0].version as number;
      const updated = await this.pool.query(
        'UPDATE diagrams SET doc = $2, yjs_state = $3, version = version + 1, updated_at = now() WHERE id = $1 AND version = $4',
        [diagramId, doc, yjsState, expected],
      );
      if ((updated.rowCount ?? 0) > 0) return; // la escritura doble se asentó de forma atómica
    }
    throw new Error(`persistRoom: gave up after ${MAX_PERSIST_RETRIES} optimistic retries (diagram ${diagramId})`);
  }
}

/** Los nombres de sala son `diagrams/<diagramId>` (o un id directo); extrae el id de diagrama. */
export function diagramIdFromRoom(docName: string): string {
  const last = docName.split('/').pop() ?? docName;
  return decodeURIComponent(last);
}
