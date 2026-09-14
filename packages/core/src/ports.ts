import type { Diagram, Delta } from './ir.js';
import type { Delta as DeltaType } from './delta.js';

/**
 * Resultado de una llamada de interpretación al LLM.
 * Es una delta candidata (para ser validada y confirmada) o un rechazo.
 */
export type LlmResult =
  | { kind: 'delta'; value: unknown }
  | { kind: 'refused'; reason: string };

/**
 * Puerto para persistir y cargar diagramas.
 * El modelo canónico del diagrama (IR) se almacena como un documento JSON.
 */
export interface DiagramRepository {
  /** Guarda un diagrama (creación o actualización). */
  save(diagram: Diagram): Promise<void>;
  /** Carga un diagrama por su ID. */
  load(id: string): Promise<Diagram | null>;
  /** Lista todos los diagramas (para navegación). */
  list(): Promise<Pick<Diagram, 'id' | 'name'>[]>;
  /** Elimina un diagrama por su ID. */
  delete(id: string): Promise<void>;
}

/**
 * Puerto para interpretación de lenguaje natural mediante LLM.
 * Recibe una petición en texto, el JSON Schema del delta y el IR actual.
 * Retorna una delta candidata o un rechazo con su motivo.
 */
export interface LlmPort {
  interpret(utterance: string, deltaJsonSchema: object, currentIr: Diagram): Promise<LlmResult>;
}

/**
 * Puerto para transcripción de voz a texto (STT).
 * Recibe los bytes del audio y retorna la transcripción en texto.
 */
export interface SttPort {
  transcribe(audio: Uint8Array, mimeType: string): Promise<string>;
}

/**
 * Puerto para extracción de diagramas a partir de imágenes (Visión).
 * Recibe una imagen y retorna una propuesta de lote de deltas (batch).
 */
export interface VisionPort {
  extract(image: Uint8Array, mimeType: string): Promise<DeltaType>;
}

/**
 * Puerto para importar diagramas desde formatos externos (ej. XMI).
 * Analiza la entrada y retorna un lote de deltas para revisión y posterior aplicación.
 */
export interface ImporterPort {
  import(source: Uint8Array, format: string): Promise<DeltaType>;
}

/**
 * Puerto para acceder a las plantillas de generación de código.
 * Las plantillas se almacenan como archivos y se cargan en tiempo de ejecución (diseño D9).
 */
export interface TemplateStore {
  /** Lista los nombres de plantillas disponibles. */
  list(): Promise<string[]>;
  /** Lee una plantilla por su ruta relativa. */
  read(rel: string): Promise<string>;
}