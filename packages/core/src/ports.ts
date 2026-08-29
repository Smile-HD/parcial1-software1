import type { Diagram, Delta } from './ir.js';
import type { Delta as DeltaType } from './delta.js';

/**
 * Result of an LLM interpretation call.
 * Either a candidate delta (to be validated and confirmed) or a refusal.
 */
export type LlmResult =
  | { kind: 'delta'; value: unknown }
  | { kind: 'refused'; reason: string };

/**
 * Port for persisting and loading diagrams.
 * The canonical diagram model (IR) is stored as a JSON document.
 */
export interface DiagramRepository {
  /** Save a diagram (create or update). */
  save(diagram: Diagram): Promise<void>;
  /** Load a diagram by ID. */
  load(id: string): Promise<Diagram | null>;
  /** List all diagrams (for navigation). */
  list(): Promise<Pick<Diagram, 'id' | 'name'>[]>;
  /** Delete a diagram by ID. */
  delete(id: string): Promise<void>;
}

/**
 * Port for LLM-based natural language interpretation.
 * Receives an utterance, the delta JSON Schema, and the current IR.
 * Returns either a candidate delta or a refusal with reason.
 */
export interface LlmPort {
  interpret(utterance: string, deltaJsonSchema: object, currentIr: Diagram): Promise<LlmResult>;
}

/**
 * Port for Speech-to-Text (STT) transcription.
 * Receives audio bytes and returns the transcript.
 */
export interface SttPort {
  transcribe(audio: Uint8Array, mimeType: string): Promise<string>;
}

/**
 * Port for Vision-based diagram extraction from images.
 * Receives an image and returns a structured delta batch proposal.
 */
export interface VisionPort {
  extract(image: Uint8Array, mimeType: string): Promise<DeltaType>;
}

/**
 * Port for importing diagrams from external formats (e.g., XMI).
 * Parses the input and returns a batch delta for review-then-apply.
 */
export interface ImporterPort {
  import(source: Uint8Array, format: string): Promise<DeltaType>;
}

/**
 * Port for accessing code generation templates.
 * Templates are stored as files and loaded at runtime (design D9).
 */
export interface TemplateStore {
  /** List available template names. */
  list(): Promise<string[]>;
  /** Read a template by relative path. */
  read(rel: string): Promise<string>;
}