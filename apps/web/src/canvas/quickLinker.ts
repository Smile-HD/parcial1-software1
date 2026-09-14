/**
 * unidad 13d — Quick Linker estilo EA: lógica PURA.
 *
 * Refleja el Quick Linker de Sparx Enterprise Architect: arrastre la flecha de la esquina
 * de un elemento seleccionado y suéltela —
 *  - sobre un elemento existente → aparece un menú de ÚNICAMENTE los tipos de conector
 *    legalmente válidos entre ambos clasificadores (`validConnectorsFor`);
 *  - sobre lienzo vacío → aparece un menú de tipos de elementos creables
 *    (`elementMenuOptions`), y luego el menú de conectores para el nuevo elemento.
 *
 * Todo aquí es puro y testeable con jsdom; el gesto de puntero en
 * DiagramCanvas es una capa delgada que solo llama a estas funciones. Las reglas
 * reflejan los invariantes del motor (packages/core apply.ts): realización es el
 * único conector condicionado por interfaz, todo lo demás es permisivo entre
 * clasificadores — coincidiendo con las protecciones existentes de `handleConnectWithTool`.
 */
import type { PaletteEdgeTool, PaletteNodeKind } from './Palette';

/** Tipos de clasificador sobre los que razona el Quick Linker (`ClassKind` de la IR). */
export type QuickLinkerKind = 'class' | 'interface';

/** Un tipo de conector ofrecido por el menú de Quick Linker — exactamente las herramientas de arista de la paleta. */
export type QuickConnectorType = PaletteEdgeTool;

/** Etiquetas de visualización para el menú de conectores (misma redacción que las herramientas de la paleta). */
export const CONNECTOR_LABELS: Record<QuickConnectorType, string> = {
  association: 'Association',
  aggregation: 'Aggregation',
  composition: 'Composition',
  generalization: 'Generalization',
  realization: 'Realization',
  dependency: 'Dependency',
};

/** Etiquetas de visualización para el menú de creación de elementos. */
export const ELEMENT_LABELS: Record<PaletteNodeKind, string> = {
  class: 'Class',
  interface: 'Interface',
};

/**
 * Los tipos de conector legalmente válidos desde `sourceKind` hacia `targetKind`.
 * Asociación/Agregación/Composición/Generalización/Dependencia siempre se
 * ofrecen (el motor protege extremos, duplicados y ciclos en tiempo de aplicación);
 * Realización aparece ÚNICAMENTE cuando el DESTINO es una interfaz — la única
 * restricción de metamodelo que el Quick Linker impone en el propio menú, reflejando
 * `RealizationTargetNotInterfaceError` en el motor central.
 * 
 * Cuando el origen y el destino son el MISMO nodo (autoenlace), se excluye la
 * generalización porque la autoherencia crea un ciclo (rechazado por el motor).
 * Asociación/agregación/composición/dependencia siguen siendo válidas para autoenlaces
 * (ej., Empleado→gestiona→Empleado, TreeNode compuesto por TreeNode).
 */
export function validConnectorsFor(
  sourceKind: QuickLinkerKind,
  targetKind: QuickLinkerKind,
  isSelfLink = false,
): QuickConnectorType[] {
  // sourceKind queda intencionalmente sin restricciones: cada clasificador puede poseer
  // asociaciones, generalizaciones y dependencias (permisivo, como los
  // controladores existentes). Solo el destino condiciona la realización.
  void sourceKind;
  const connectors: QuickConnectorType[] = [
    'association',
    'aggregation',
    'composition',
    'generalization',
  ];
  if (targetKind === 'interface') {
    connectors.push('realization');
  }
  connectors.push('dependency');
  
  // Autoenlace: excluir generalización (la autoherencia es un ciclo)
  if (isSelfLink) {
    return connectors.filter((c) => c !== 'generalization');
  }
  return connectors;
}

/** Un rectángulo de nodo para la prueba de impacto (hit-test): posición más (cuando esté medido) tamaño. */
export interface QuickLinkerNode {
  id: string;
  position: { x: number; y: number };
  /** Ancho medido de React Flow; undefined hasta que el nodo haya sido medido. */
  width?: number;
  /** Alto medido de React Flow; undefined hasta que el nodo haya sido medido. */
  height?: number;
}

/** Caja de respaldo para nodos sin medir (jsdom nunca mide; los navegadores reales sí). */
export const DEFAULT_NODE_WIDTH = 180;
export const DEFAULT_NODE_HEIGHT = 120;

/**
 * ¿Qué nodo (si alguno) se encuentra bajo el punto de soltado? Contención rectangular en
 * coordenadas de FLUJO. Retorna el ÚLTIMO nodo coincidente para que las pilas superpuestas
 * resuelvan al renderizado más arriba, y `null` para lienzo vacío — la
 * señal para abrir el menú de elementos en lugar del menú de conectores.
 */
export function quickLinkerTarget(
  dropPoint: { x: number; y: number },
  nodes: readonly QuickLinkerNode[],
): string | null {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]!;
    const width = node.width ?? DEFAULT_NODE_WIDTH;
    const height = node.height ?? DEFAULT_NODE_HEIGHT;
    const withinX = dropPoint.x >= node.position.x && dropPoint.x <= node.position.x + width;
    const withinY = dropPoint.y >= node.position.y && dropPoint.y <= node.position.y + height;
    if (withinX && withinY) {
      return node.id;
    }
  }
  return null;
}

/**
 * Los tipos de elemento que el Quick Linker puede crear al soltar en lienzo vacío —
 * exactamente los tipos de nodo arrastrables de la paleta.
 */
export function elementMenuOptions(): PaletteNodeKind[] {
  return ['class', 'interface'];
}
