/**
 * Registro de trabajos en proceso (diseño D8) para operaciones lentas: codegen,
 * importación de fotos, etc. Capacidad acotada: como máximo `maxJobs` entradas
 * (por defecto 100), cada artefacto limitado a `maxArtifactBytes`
 * (por defecto 50 MB), entradas más antiguas que `jobTtlMs` (por defecto 5 min)
 * desalojadas en cada mutación. Sin persistencia tras reinicios —
 * esto es intencional según el diseño D8. Ver
 * openspec/changes/ai-uml-design-tool/design.md (D8).
 *
 * Revisión R3-ARTIFACT-INMEM (PR 14d): el Map sin límites previo podía
 * fugar memoria bajo tráfico sostenido. Los límites aquí mantienen el registro
 * en O(maxJobs) sin importar la tasa de entrada.
 */

import { randomUUID } from 'node:crypto';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Job {
  id: string;
  diagramId: string;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
  artifact?: Buffer; // búfer zip al completarse con éxito
  error?: string; // mensaje de error al fallar
}

export interface JobRegistryLimits {
  maxJobs: number;
  maxArtifactBytes: number;
  jobTtlMs: number;
}

export const DEFAULT_LIMITS: JobRegistryLimits = {
  maxJobs: 100,
  maxArtifactBytes: 50 * 1024 * 1024, // 50 MB
  jobTtlMs: 5 * 60 * 1000, // 5 minutes
};

export class JobRegistry {
  private readonly jobs = new Map<string, Job>();
  private readonly limitsConfig: JobRegistryLimits;

  constructor(limits: Partial<JobRegistryLimits> = {}) {
    this.limitsConfig = { ...DEFAULT_LIMITS, ...limits };
  }

  limits(): JobRegistryLimits {
    return { ...this.limitsConfig };
  }

  size(): number {
    return this.jobs.size;
  }

  /**
   * Solo para pruebas: elimina cada entrada. No se usa en código de producción.
   * La limpieza en producción es el desalojo por mutación + límite de TTL.
   */
  clear(): void {
    this.jobs.clear();
  }

  /**
   * Retorna el trabajo no terminal (en cola o en ejecución) más reciente para
   * el diagrama dado, o undefined. Se usa para aplicar contrapresión en
   * `POST /diagrams/:id/generate` — si ya hay un trabajo en curso, la nueva
   * solicitud se rechaza con 409 y se retorna este id.
   */
  findActiveByDiagramId(diagramId: string): Job | undefined {
    let latest: Job | undefined;
    for (const job of this.jobs.values()) {
      if (job.diagramId !== diagramId) continue;
      if (job.status !== 'queued' && job.status !== 'running') continue;
      if (!latest || job.updatedAt.getTime() > latest.updatedAt.getTime()) {
        latest = job;
      }
    }
    return latest;
  }

  create(diagramId: string): Job {
    this.evict();
    const job: Job = {
      id: randomUUID(),
      diagramId,
      status: 'queued',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.jobs.set(job.id, job);
    this.enforceMaxJobs();
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  setRunning(id: string): void {
    const job = this.jobs.get(id);
    if (job) {
      job.status = 'running';
      job.updatedAt = new Date();
    }
  }

  setSucceeded(id: string, artifact: Buffer): void {
    const job = this.jobs.get(id);
    if (!job) return;
    if (artifact.byteLength > this.limitsConfig.maxArtifactBytes) {
      // NO almacenar el búfer sobredimensionado. Marcar como fallido y reportar bytes
      // para que el invocador decida qué hacer (aguas abajo se mantiene en 5xx/409).
      this.setFailed(
        id,
        `artifact too large: ${artifact.byteLength} bytes (max ${this.limitsConfig.maxArtifactBytes} bytes)`,
      );
      return;
    }
    this.evict();
    job.status = 'succeeded';
    job.artifact = artifact;
    delete job.error;
    job.updatedAt = new Date();
    this.enforceMaxJobs();
  }

  setFailed(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (job) {
      this.evict();
      job.status = 'failed';
      delete job.artifact;
      job.error = error;
      job.updatedAt = new Date();
      this.enforceMaxJobs();
    }
  }

  /**
   * Elimina trabajos más antiguos que `jobTtlMs` (por updatedAt). Idempotente.
   */
  private evict(): void {
    const cutoff = Date.now() - this.limitsConfig.jobTtlMs;
    for (const [id, job] of this.jobs) {
      if (job.updatedAt.getTime() < cutoff) {
        this.jobs.delete(id);
      }
    }
  }

  /**
   * Tras la inserción, descarta el más antiguo por updatedAt hasta estar dentro del límite.
   * La iteración del Map es en orden de inserción; ordenamos la instantánea por updatedAt
   * para desalojar por LRU real en lugar de FIFO.
   */
  private enforceMaxJobs(): void {
    if (this.jobs.size <= this.limitsConfig.maxJobs) return;
    const sorted = [...this.jobs.entries()].sort(
      (a, b) => a[1].updatedAt.getTime() - b[1].updatedAt.getTime(),
    );
    const toDrop = this.jobs.size - this.limitsConfig.maxJobs;
    for (let i = 0; i < toDrop; i++) {
      const entry = sorted[i];
      if (entry) this.jobs.delete(entry[0]);
    }
  }
}

export const jobRegistry = new JobRegistry();
