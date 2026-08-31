/**
 * Typed client for the voice endpoint (PR 8, task 8.2/8.3).
 *
 * The browser records a short utterance and POSTs it (base64) to
 * /diagrams/:id/voice. The endpoint returns the transcript plus the SAME
 * interpret outcome shape as the text path (voice:R2 — no privileged flow).
 */
import type { InterpretResponse } from './diagramApi';
import { bytesToBase64 } from './base64';

const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? 'http://localhost:3000';

/** Outcome of POST /diagrams/:id/voice: transcript + interpreter outcome. */
export type VoiceResponse = InterpretResponse & { transcript: string };

/** POST /diagrams/:id/voice — audio bytes → transcript → interpreter outcome. */
export async function transcribeAudio(
  diagramId: string,
  audio: Uint8Array,
  mimeType: string,
): Promise<VoiceResponse> {
  const response = await fetch(`${API_BASE_URL}/diagrams/${diagramId}/voice`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ audio: bytesToBase64(audio), mimeType }),
  });
  const body = (await response.json().catch(() => null)) as
    | (VoiceResponse & { error?: string })
    | null;
  if (!response.ok) {
    // The 502 body already carries the voice:R1 fallback direction.
    throw new Error(body?.error ?? `API error ${response.status}`);
  }
  if (body === null) {
    throw new Error('API returned a non-JSON body');
  }
  return body;
}
