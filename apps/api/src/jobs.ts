/**
 * In-process job registry (design D8) for slow operations: codegen,
 * photo import, etc. Bounded capacity: at most `maxJobs` entries
 * (default 100), each artifact capped at `maxArtifactBytes`
 * (default 50 MB), entries older than `jobTtlMs` (default 5 min)
 * evicted on every mutation. No persistence across restarts —
 * this is intentional per design D8. See
 * openspec/changes/ai-uml-design-tool/design.md (D8).
 *
 * Review R3-ARTIFACT-INMEM (PR 14d): the previous unbounded Map could
 * leak memory under sustained traffic. Bounds here keep the registry
 * O(maxJobs) regardless of input rate.
 */

import { randomUUID } from 'node:crypto';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed';

export interface Job {
  id: string;
  diagramId: string;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
  artifact?: Buffer; // zip buffer when succeeded
  error?: string; // error message when failed
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
   * Test-only: drop every entry. Not used in production code.
   * Production cleanup is the per-mutation eviction + TTL cap.
   */
  clear(): void {
    this.jobs.clear();
  }

  /**
   * Return the most recent non-terminal (queued or running) job for the
   * given diagram, or undefined. Used to enforce backpressure on
   * `POST /diagrams/:id/generate` — if a job is already in flight, the
   * new request is rejected with 409 and this id is returned.
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
      // Do NOT store the oversized buffer. Mark as failed and report bytes
      // so the caller can decide what to do (downstream stays in 5xx/409).
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
   * Remove jobs older than `jobTtlMs` (by updatedAt). Idempotent.
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
   * After insertion, drop the oldest by updatedAt until at or under cap.
   * Map iteration is insertion order; we sort the snapshot by updatedAt
   * to evict truly-LRU rather than FIFO.
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
