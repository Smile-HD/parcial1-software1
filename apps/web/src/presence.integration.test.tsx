/**
 * Presence integration (6b.3) — two App instances bound to a REAL collab
 * server must see each other in the presence bar. This pins the awareness
 * wiring end-to-end (provider → room → awareness relay → React state).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { startCollabServer, type CollabServer } from '@app/collab-server';
import { buildYDocFromDiagram, encodeYDoc, type Diagram } from '@app/core';

import { App } from './App';
import { bytesToBase64 } from './api/base64';

const TEST_DATABASE_URL = 'postgres://postgres:postgres@localhost:5433/ai_uml_test';

function makeDiagram(): Diagram {
  const customerId = crypto.randomUUID();
  const orderId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    name: 'Presence Test',
    classes: [
      { id: customerId, name: 'Customer', position: { x: 0, y: 0 }, attributes: [], methods: [] },
      { id: orderId, name: 'Order', position: { x: 300, y: 0 }, attributes: [], methods: [] },
    ],
    associations: [],
  };
}

let server: CollabServer;
let wsUrl: string;

beforeAll(async () => {
  server = await startCollabServer({ port: 0, host: '127.0.0.1', databaseUrl: TEST_DATABASE_URL });
  wsUrl = `ws://127.0.0.1:${server.port}`;
}, 20_000);

afterAll(async () => {
  await server.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('presence over a real collab server (6b.3)', () => {
  it('two App instances on the same room each list BOTH users in the presence bar', async () => {
    const diagram = makeDiagram();
    const resource = {
      id: diagram.id,
      name: diagram.name,
      diagram,
      yjsState: bytesToBase64(encodeYDoc(buildYDocFromDiagram(diagram))),
      version: 1,
      createdAt: 't',
      updatedAt: 't',
    };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => resource }),
    );

    window.location.hash = `#/d/${diagram.id}`;
    const first = render(<App doc={new Y.Doc()} collabUrl={wsUrl} />);
    const second = render(<App doc={new Y.Doc()} collabUrl={wsUrl} />);

    try {
      // Each instance's presence bar must eventually list TWO users:
      // its own ephemeral identity plus the peer's, relayed by the room.
      await waitFor(
        () => {
          const bars = screen.getAllByLabelText('Online users');
          expect(bars.length).toBe(2);
          for (const bar of bars) {
            expect(bar.querySelectorAll('.presence-bar__user').length).toBe(2);
          }
        },
        { timeout: 10_000 },
      );
    } finally {
      first.unmount();
      second.unmount();
    }
  }, 25_000);
});
