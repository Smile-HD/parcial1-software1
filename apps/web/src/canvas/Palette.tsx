/**
 * Palette — the left creation rail for the UML editor (unit 13b).
 *
 * Two interaction idioms, mirroring standard UML tools:
 *  - NODE items (Class, Interface) are HTML5-draggable: drag one onto the
 *    canvas and the drop handler creates the node at the drop position. The
 *    dragged kind travels in the dataTransfer under PALETTE_DND_MIME.
 *  - EDGE items (Association, Aggregation, Composition, Generalization,
 *    Realization, Dependency) are click-to-ARM tools: clicking one arms it
 *    (highlighted via aria-pressed and the --active class); the user then
 *    drags a React Flow connection from a source node to a target node, and
 *    the canvas emits that tool's delta on connect. Clicking the armed item
 *    again (or pressing Escape) disarms it. With no tool armed, connections
 *    are not even startable (nodesConnectable is false) — no accidental edges.
 *  - The N-ary diamond enters the EXISTING pick-≥3 mode (it needs at least
 *    three ends, so it is deliberately not an A→B drag gesture).
 *
 * unit 13c — the rail is organized into TWO labeled blocks: OBJECTS (the
 * draggable classifiers) and RELATIONS (every edge tool + the n-ary mode).
 * Aggregation/Composition are association tools with the diamond kind
 * preset: drawing one creates an association carrying aggregation
 * 'shared'/'composite' instead of editing it afterwards.
 *
 * Glyphs reuse the visual language of the edge components (solid/dashed
 * lines, hollow triangle, open V arrow, hollow/filled diamond) so the
 * palette teaches the notation it creates.
 */
import type { DragEvent, ReactElement } from 'react';

/** Node kinds that can be dragged from the palette onto the canvas. */
export type PaletteNodeKind = 'class' | 'interface';

/**
 * Binary edge tools armed by a palette click. Aggregation and composition
 * behave exactly like association but preset the aggregation kind on the
 * created association (unit 13c).
 */
export type PaletteEdgeTool =
  | 'association'
  | 'aggregation'
  | 'composition'
  | 'generalization'
  | 'realization'
  | 'dependency';

/** dataTransfer mime carrying the dragged node kind to the canvas drop handler. */
export const PALETTE_DND_MIME = 'application/x-uml-palette';

export interface PaletteProps {
  activeEdgeTool: PaletteEdgeTool | null;
  naryMode: boolean;
  onEdgeToolChange: (tool: PaletteEdgeTool | null) => void;
  onNaryModeToggle: () => void;
}

const INK = '#1a1a2e';

function ClassGlyph() {
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <rect x="2" y="2" width="40" height="18" fill="#fff" stroke={INK} strokeWidth="2" />
      <line x1="2" y1="9" x2="42" y2="9" stroke={INK} strokeWidth="1" />
    </svg>
  );
}

function InterfaceGlyph() {
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <rect x="2" y="2" width="40" height="18" fill="#fff" stroke={INK} strokeWidth="2" strokeDasharray="4 2" />
      <line x1="2" y1="9" x2="42" y2="9" stroke={INK} strokeWidth="1" />
    </svg>
  );
}

function AssociationGlyph() {
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="42" y2="11" stroke={INK} strokeWidth="2" />
    </svg>
  );
}

/**
 * unit 13c — aggregation/composition glyphs: the diamond sits on the SOURCE
 * (left) end, mirroring the default aggregationEnd='source' of the created
 * association. Hollow = shared aggregation, filled = composition.
 */
function AggregationGlyph() {
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="14" y1="11" x2="42" y2="11" stroke={INK} strokeWidth="2" />
      <path d="M 2 11 L 9 4 L 16 11 L 9 18 Z" fill="#fff" stroke={INK} strokeWidth="2" />
    </svg>
  );
}

function CompositionGlyph() {
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="14" y1="11" x2="42" y2="11" stroke={INK} strokeWidth="2" />
      <path d="M 2 11 L 9 4 L 16 11 L 9 18 Z" fill={INK} stroke={INK} strokeWidth="2" />
    </svg>
  );
}

/** Hollow triangle arrowhead (UML generalization/realization). */
function triangle(x: number) {
  return <path d={`M ${x} 3 L ${x + 12} 11 L ${x} 19 Z`} fill="#fff" stroke={INK} strokeWidth="2" />;
}

function GeneralizationGlyph() {
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="30" y2="11" stroke={INK} strokeWidth="2" />
      {triangle(30)}
    </svg>
  );
}

function RealizationGlyph() {
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="30" y2="11" stroke={INK} strokeWidth="2" strokeDasharray="5 3" />
      {triangle(30)}
    </svg>
  );
}

function DependencyGlyph() {
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="31" y2="11" stroke={INK} strokeWidth="2" strokeDasharray="5 3" />
      <path d="M 31 3 L 42 11 L 31 19" fill="none" stroke={INK} strokeWidth="2" />
    </svg>
  );
}

function NaryGlyph() {
  return (
    <svg width="44" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <path d="M 22 1 L 41 11 L 22 21 L 3 11 Z" fill="#fff" stroke={INK} strokeWidth="2" />
    </svg>
  );
}

const EDGE_TOOLS: ReadonlyArray<{
  tool: PaletteEdgeTool;
  testId: string;
  label: string;
  glyph: ReactElement;
}> = [
  { tool: 'association', testId: 'palette-association', label: 'Association', glyph: <AssociationGlyph /> },
  { tool: 'aggregation', testId: 'palette-aggregation', label: 'Aggregation', glyph: <AggregationGlyph /> },
  { tool: 'composition', testId: 'palette-composition', label: 'Composition', glyph: <CompositionGlyph /> },
  { tool: 'generalization', testId: 'palette-generalization', label: 'Generalization', glyph: <GeneralizationGlyph /> },
  { tool: 'realization', testId: 'palette-realization', label: 'Realization', glyph: <RealizationGlyph /> },
  { tool: 'dependency', testId: 'palette-dependency', label: 'Dependency', glyph: <DependencyGlyph /> },
];

export function Palette({ activeEdgeTool, naryMode, onEdgeToolChange, onNaryModeToggle }: PaletteProps) {
  const startNodeDrag = (kind: PaletteNodeKind) => (event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData(PALETTE_DND_MIME, kind);
    event.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <aside className="palette" aria-label="UML element palette">
      {/* unit 13c — block 1: the draggable objects. */}
      <div className="palette__group" role="group" aria-label="Objects">
        <span className="palette__group-title">Objects</span>
        <button
          type="button"
          className="palette__item"
          data-testid="palette-class"
          draggable
          onDragStart={startNodeDrag('class')}
          aria-label="Create class (drag onto canvas)"
          title="Drag onto the canvas to create a class"
        >
          <ClassGlyph />
          <span className="palette__label">Class</span>
        </button>
        <button
          type="button"
          className="palette__item"
          data-testid="palette-interface"
          draggable
          onDragStart={startNodeDrag('interface')}
          aria-label="Create interface (drag onto canvas)"
          title="Drag onto the canvas to create an interface"
        >
          <InterfaceGlyph />
          <span className="palette__label">Interface</span>
        </button>
      </div>

      {/* unit 13c — block 2: every relation tool, including the n-ary mode. */}
      <div className="palette__group" role="group" aria-label="Relations">
        <span className="palette__group-title">Relations</span>
        {EDGE_TOOLS.map(({ tool, testId, label, glyph }) => (
          <button
            key={tool}
            type="button"
            className={`palette__item${activeEdgeTool === tool ? ' palette__item--active' : ''}`}
            data-testid={testId}
            aria-label={`${label} edge tool`}
            aria-pressed={activeEdgeTool === tool}
            title={`Click, then drag between two nodes to create a ${label.toLowerCase()}`}
            onClick={() => onEdgeToolChange(activeEdgeTool === tool ? null : tool)}
          >
            {glyph}
            <span className="palette__label">{label}</span>
          </button>
        ))}
        <button
          type="button"
          className={`palette__item${naryMode ? ' palette__item--active' : ''}`}
          data-testid="palette-nary"
          aria-label="N-ary association tool (pick 3 or more classes)"
          aria-pressed={naryMode}
          title="Click, then pick at least three classes"
          onClick={onNaryModeToggle}
        >
          <NaryGlyph />
          <span className="palette__label">N-ary</span>
        </button>
      </div>
    </aside>
  );
}
