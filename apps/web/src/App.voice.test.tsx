/**
 * Voice input UI (PR 8, tasks 8.3/8.4) — web tests.
 *
 * voice:R1 — an STT outage shows an explicit message directing the user to
 * the text command input fallback. voice:R2 — the transcribed text goes
 * through the SAME interpreter + confirm flow (reuses App.tsx submit). R3 —
 * the transcript is editable before submission, so correcting a misheard
 * class name does not force re-recording.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { buildYDocFromDiagram, encodeYDoc, projectYDocToDiagram, type Delta, type Diagram } from '@app/core';

import { App } from './App';
import { bytesToBase64 } from './api/base64';
import { transcribeAudio } from './api/voiceApi';

function makeFixture(): Diagram {
  const customerId = crypto.randomUUID();
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Shop',
    classes: [
      { id: customerId, name: 'Customer', position: { x: 10, y: 20 }, attributes: [], methods: [] },
    ],
    associations: [],
  };
}

function addClassDelta(diagramId: string, name: string): Delta {
  return {
    id: crypto.randomUUID(),
    diagramId,
    timestamp: '2026-08-31T12:00:00.000Z',
    kind: 'class',
    op: 'create',
    classId: crypto.randomUUID(),
    name,
    position: { x: 120, y: 80 },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function resourceOf(diagram: Diagram, version: number): Record<string, unknown> {
  return {
    id: diagram.id,
    name: diagram.name,
    diagram,
    yjsState: bytesToBase64(encodeYDoc(buildYDocFromDiagram(diagram))),
    version,
    createdAt: 't',
    updatedAt: 't',
  };
}

interface VoiceRoute {
  /** Ordered voice-endpoint responses. */
  voiceQueue: Array<{ status: number; body: unknown }>;
  /** Ordered /interpret responses (used when the corrected text is re-sent). */
  interpretQueue: Array<{ status: number; body: unknown }>;
  deltaId: string;
  delta: Delta;
}

/** One unified stub handling GET/PUT diagram, ordered /voice and /interpret replies, confirm. */
function stubFetch(diagram: Diagram, route: VoiceRoute): { confirms: number } {
  const counters = { confirms: 0 };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'PUT' && url.endsWith(`/diagrams/${diagram.id}`)) {
        return Promise.resolve(jsonResponse(resourceOf(diagram, 4)));
      }
      if (method === 'GET' && url.endsWith(`/diagrams/${diagram.id}`)) {
        return Promise.resolve(jsonResponse(resourceOf(diagram, 3)));
      }
      if (method === 'POST' && url.endsWith('/voice')) {
        const next = route.voiceQueue.shift();
        if (next === undefined) {
          return Promise.reject(new Error('no voice response queued'));
        }
        return Promise.resolve(jsonResponse(next.body, next.status));
      }
      if (method === 'POST' && url.endsWith('/interpret')) {
        const next = route.interpretQueue.shift();
        if (next === undefined) {
          return Promise.reject(new Error('no interpret response queued'));
        }
        return Promise.resolve(jsonResponse(next.body, next.status));
      }
      if (method === 'POST' && url.includes(`/deltas/${route.deltaId}/confirm`)) {
        counters.confirms += 1;
        return Promise.resolve(jsonResponse({ status: 'confirmed', delta: route.delta, diagramId: diagram.id }));
      }
      return Promise.reject(new Error(`unexpected fetch ${method} ${url}`));
    }),
  );
  return counters;
}

/** Installs fake recording plumbing (mic, MediaRecorder, Blob bytes). */
function installFakeRecorder(): void {
  // vi.stubGlobal cannot patch nested properties — define navigator.mediaDevices directly.
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] } as unknown as MediaStream) },
  });
  navigatorMediaDevicesPatched = true;
  class FakeRecorder {
    static isTypeSupported(): boolean {
      return true;
    }
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start(): void {
      this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) });
    }
    stop(): void {
      this.onstop?.();
    }
  }
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  // jsdom's Blob lacks arrayBuffer — provide it so the recorder can read the bytes.
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    configurable: true,
    value: (): Promise<ArrayBuffer> => Promise.resolve(new TextEncoder().encode('fake-audio').buffer as ArrayBuffer),
  });
  blobArrayBufferPatched = true;
}

let blobArrayBufferPatched = false;
let navigatorMediaDevicesPatched = false;

/** Renders the loaded app, presses Record, then Stop (queued voice reply). */
async function startAndRecord(diagram: Diagram, doc: Y.Doc, route: VoiceRoute): Promise<{ confirms: number }> {
  const counters = stubFetch(diagram, route);
  installFakeRecorder();
  window.location.hash = `#/d/${diagram.id}`;
  render(<App doc={doc} />);
  expect(await screen.findByText('Customer')).toBeTruthy();
  fireEvent.click(screen.getByText('Record'));
  // startRecording resolves on a microtask — wait for the toggle to Stop.
  await waitFor(() => expect(screen.getByText('Stop')).toBeTruthy());
  fireEvent.click(screen.getByText('Stop'));
  return counters;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (blobArrayBufferPatched) {
    delete (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer;
    blobArrayBufferPatched = false;
  }
  if (navigatorMediaDevicesPatched) {
    delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    navigatorMediaDevicesPatched = false;
  }
  window.location.hash = '';
});

describe('transcribeAudio helper (8.3)', () => {
  it('POSTs base64 audio + mimeType and returns the transcript', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ transcript: 'add class Invoice', status: 'pending' }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await transcribeAudio('d1', new Uint8Array([1, 2]), 'audio/webm');

    expect(result).toEqual({ transcript: 'add class Invoice', status: 'pending' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:3000/diagrams/d1/voice');
    expect(JSON.parse(String(init.body))).toEqual({ audio: 'AQI=', mimeType: 'audio/webm' });
  });
});

describe('Voice input (voice:R1/R2/R3)', () => {
  it('8.4 shows the transcript editable in the command input and interpretation runs on the CORRECTED text', async () => {
    const diagram = makeFixture();
    const doc = new Y.Doc();
    const delta = addClassDelta(diagram.id, 'Invoice');
    const counters = await startAndRecord(diagram, doc, {
      deltaId: 'voice-delta-1',
      delta,
      voiceQueue: [
        { status: 200, body: { transcript: 'add a class Involve', status: 'pending', deltaId: 'voice-delta-1', delta } },
      ],
      // The corrected text re-enters the SAME text pipeline (voice:R3).
      interpretQueue: [
        { status: 200, body: { status: 'pending', deltaId: 'voice-delta-1', delta } },
      ],
    });

    // Transcript lands in the editable command input (R3): visible + editable.
    const input = (await screen.findByLabelText('Natural language command')) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('add a class Involve'));

    // User corrects the misheard name, then submits.
    fireEvent.change(input, { target: { value: 'add a class Invoice' } });
    fireEvent.click(screen.getByText('Send'));

    // The pending preview reflects the CORRECTED command (R2: same flow).
    expect(await screen.findByText('Add class "Invoice"')).toBeTruthy();

    fireEvent.click(screen.getByText('Confirm'));
    expect(await screen.findByText('Invoice')).toBeTruthy();
    expect(projectYDocToDiagram(doc).classes.map((c) => c.name)).toEqual(['Customer', 'Invoice']);
    expect(counters.confirms).toBe(1);
  });

  it('8.3 STT outage shows an explicit message directing to the text input fallback', async () => {
    const diagram = makeFixture();
    const doc = new Y.Doc();
    await startAndRecord(diagram, doc, {
      deltaId: 'voice-delta-1',
      delta: addClassDelta(diagram.id, 'Invoice'),
      voiceQueue: [
        {
          status: 502,
          body: { error: 'Speech-to-text unavailable: service down. Use the text command input instead.' },
        },
      ],
      interpretQueue: [],
    });

    expect(
      await screen.findByText(/Speech-to-text unavailable.*Use the text command input instead/),
    ).toBeTruthy();
    // The text input stays usable as the fallback (voice:R1).
    expect(screen.getByLabelText('Natural language command')).toBeTruthy();
  });
});
