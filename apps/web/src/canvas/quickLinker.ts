/**
 * unit 13d — EA-style Quick Linker: PURE logic.
 *
 * Mirrors Sparx Enterprise Architect's Quick Linker: drag the corner arrow of
 * a selected element and drop it —
 *  - on an existing element → a menu of ONLY the legally-valid connector
 *    types between the two classifiers appears (`validConnectorsFor`);
 *  - on empty canvas → a menu of creatable element types appears
 *    (`elementMenuOptions`), then the connector menu for the new element.
 *
 * Everything here is pure and jsdom-testable; the pointer gesture in
 * DiagramCanvas is a thin shell that only calls these functions. The rules
 * mirror the engine's invariants (packages/core apply.ts): realization is the
 * single interface-gated connector, everything else is permissive between
 * classifiers — matching the existing `handleConnectWithTool` guards.
 */
import type { PaletteEdgeTool, PaletteNodeKind } from './Palette';

/** Classifier kinds the Quick Linker reasons about (IR `ClassKind`). */
export type QuickLinkerKind = 'class' | 'interface';

/** A connector type offered by the Quick Linker menu — exactly the palette edge tools. */
export type QuickConnectorType = PaletteEdgeTool;

/** Display labels for the connector menu (same wording as the palette tools). */
export const CONNECTOR_LABELS: Record<QuickConnectorType, string> = {
  association: 'Association',
  aggregation: 'Aggregation',
  composition: 'Composition',
  generalization: 'Generalization',
  realization: 'Realization',
  dependency: 'Dependency',
};

/** Display labels for the element-creation menu. */
export const ELEMENT_LABELS: Record<PaletteNodeKind, string> = {
  class: 'Class',
  interface: 'Interface',
};

/**
 * The connector types legally valid from `sourceKind` to `targetKind`.
 * Association/Aggregation/Composition/Generalization/Dependency are always
 * offered (the engine guards endpoints, duplicates and cycles at apply time);
 * Realization appears ONLY when the TARGET is an interface — the one
 * metamodel gate the Quick Linker enforces in the menu itself, mirroring
 * `RealizationTargetNotInterfaceError` in the core engine.
 * 
 * When source and target are the SAME node (self-link), generalization is
 * excluded because self-inheritance creates a cycle (rejected by the engine).
 * Association/aggregation/composition/dependency remain valid for self-links
 * (e.g., Employee→manages→Employee, TreeNode composed of TreeNode).
 */
export function validConnectorsFor(
  sourceKind: QuickLinkerKind,
  targetKind: QuickLinkerKind,
  isSelfLink = false,
): QuickConnectorType[] {
  // sourceKind is intentionally unconstrained: every classifier may own
  // associations, generalizations and dependencies (permissive, like the
  // existing handlers). Only the target gates realization.
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
  
  // Self-link: exclude generalization (self-inheritance is a cycle)
  if (isSelfLink) {
    return connectors.filter((c) => c !== 'generalization');
  }
  return connectors;
}

/** A node rectangle for the hit-test: position plus (when measured) size. */
export interface QuickLinkerNode {
  id: string;
  position: { x: number; y: number };
  /** React Flow's measured width; undefined until the node has been measured. */
  width?: number;
  /** React Flow's measured height; undefined until the node has been measured. */
  height?: number;
}

/** Fallback box for unmeasured nodes (jsdom never measures; real browsers do). */
export const DEFAULT_NODE_WIDTH = 180;
export const DEFAULT_NODE_HEIGHT = 120;

/**
 * Which node (if any) sits under the drop point? Rectangle containment in
 * FLOW coordinates. Returns the LAST matching node so overlapping stacks
 * resolve to the topmost-rendered one, and `null` for empty canvas — the
 * signal to open the element menu instead of the connector menu.
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
 * The element types the Quick Linker can create on an empty-canvas drop —
 * exactly the palette's draggable node kinds.
 */
export function elementMenuOptions(): PaletteNodeKind[] {
  return ['class', 'interface'];
}
