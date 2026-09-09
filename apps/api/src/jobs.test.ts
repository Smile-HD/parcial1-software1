/**
 * Unit 14d — JobRegistry memory safety tests (review R3-ARTIFACT-INMEM).
 * Verifies TTL eviction, maxJobs LRU, and maxArtifactBytes rejection.
 * No persistence — D8 design.
 */

import { describe, expect, it, vi } from 'vitest';
import { JobRegistry } from './jobs.js';

describe('JobRegistry memory safety', () => {
  it('rejects artifact larger than maxArtifactBytes and marks job failed', () => {
    const reg = new JobRegistry({ maxArtifactBytes: 100 });
    const job = reg.create('diagram-1');
    const oversized = Buffer.alloc(101, 0x61); // 101 bytes of 'a'
    reg.setSucceeded(job.id, oversized);
    const after = reg.get(job.id);
    expect(after?.status).toBe('failed');
    expect(after?.artifact).toBeUndefined();
    expect(after?.error).toMatch(/too large/i);
  });

  it('accepts artifact within maxArtifactBytes', () => {
    const reg = new JobRegistry({ maxArtifactBytes: 100 });
    const job = reg.create('diagram-1');
    const ok = Buffer.from('hello');
    reg.setSucceeded(job.id, ok);
    const after = reg.get(job.id);
    expect(after?.status).toBe('succeeded');
    expect(after?.artifact).toBe(ok);
  });

  it('evicts oldest jobs when over maxJobs', () => {
    const reg = new JobRegistry({ maxJobs: 3, jobTtlMs: 60_000 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const created = reg.create(`d-${i}`);
      ids.push(created.id);
    }
    // create() should have evicted the two oldest
    expect(reg.size()).toBeLessThanOrEqual(3);
    // The two oldest ids (ids[0], ids[1]) should be gone
    expect(reg.get(ids[0]!)).toBeUndefined();
    expect(reg.get(ids[1]!)).toBeUndefined();
  });

  it('evicts jobs older than jobTtlMs', () => {
    vi.useFakeTimers();
    try {
      const reg = new JobRegistry({ jobTtlMs: 1_000 });
      const job = reg.create('d-1');
      reg.setRunning(job.id);
      // advance past TTL
      vi.advanceTimersByTime(2_000);
      // Trigger eviction by creating another
      reg.create('d-2');
      expect(reg.get(job.id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('default constructor uses safe defaults', () => {
    const reg = new JobRegistry();
    const limits = reg.limits();
    expect(limits.maxJobs).toBe(100);
    expect(limits.maxArtifactBytes).toBe(50 * 1024 * 1024);
    expect(limits.jobTtlMs).toBe(5 * 60 * 1000);
  });
});
