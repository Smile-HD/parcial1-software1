/**
 * Palette — el riel de creación izquierdo para el editor UML (unidad 13b).
 *
 * Dos modismos de interacción, reflejando herramientas UML estándar:
 *  - Ítems NODO (Class, Interface) son arrastrables mediante HTML5: arrastre uno
 *    hacia el lienzo y el controlador de drop crea el nodo en la posición de soltado.
 *    El tipo arrastrado viaja en dataTransfer bajo PALETTE_DND_MIME.
 *  - Ítems ARISTA (Association, Aggregation, Composition, Generalization,
 *    Realization, Dependency) son herramientas armables por clic: hacer clic en una
 *    la arma (destacada vía aria-pressed y la clase --active); el usuario luego
 *    arrastra una conexión de React Flow desde un nodo origen a un nodo destino, y
 *    el lienzo emite el delta de esa herramienta al conectar. Hacer clic en el ítem
 *    armado nuevamente (o presionar Escape) la desarma. Sin ninguna herramienta armada,
 *    las conexiones ni siquiera se pueden iniciar (nodesConnectable es false) — sin aristas accidentales.
 *  - El diamante N-ario entra en el modo EXISTENTE de selección ≥3 (necesita al menos
 *    tres extremos, por lo que deliberadamente no es un gesto de arrastre A→B).
 *
 * unidad 13c — el riel se organiza en DOS bloques etiquetados: OBJETOS (los
 * clasificadores arrastrables) y RELACIONES (cada herramienta de arista + el modo n-ario).
 * Agregación/Composición son herramientas de asociación con el tipo de diamante
 * preestablecido: dibujar una crea una asociación con agregación
 * 'shared'/'composite' en lugar de editarla posteriormente.
 *
 * unidad 13e.9 pulido — la caja de herramientas se rediseña como un panel acoplado
 * limpio estilo EA: mosaicos de iconos consistentes (glifos UML nítidos en un chip blanco),
 * etiquetas de 12.5px, encabezados de sección con separadores, un estado hover real y
 * un estado armado evidente (relleno azul EA + barra de acento izquierda). Todos los
 * testids/aria/roles y ambos modismos de interacción permanecen intactos.
 * unidad 13e.10 — colapso opcional: el lienzo posee una bandera `collapsed` y un
 * controlador `onToggleCollapsed` (botón de encabezado, data-testid="palette-toggle");
 * el CSS también se autocolapsa solo a iconos en viewports estrechos.
 * unidad 13e.11 — cada etiqueta pasa por el diccionario i18n (EN/ES en vivo).
 *
 * Los glifos reutilizan el lenguaje visual de los componentes de aristas (líneas
 * continuas/punteadas, triángulo hueco, flecha en V abierta, diamante hueco/lleno)
 * para que la paleta enseñe la notación que crea.
 */
import type { DragEvent, ReactElement } from 'react';

import { useT, type TKey } from '../i18n';

/** Tipos de nodo que pueden arrastrarse desde la paleta hacia el lienzo. */
export type PaletteNodeKind = 'class' | 'interface';

/**
 * Herramientas de arista binaria armadas mediante clic en la paleta. Agregación y composición
 * se comportan exactamente como asociación pero preestablecen el tipo de agregación en la
 * asociación creada (unidad 13c).
 */
export type PaletteEdgeTool =
  | 'association'
  | 'associationClass'
  | 'aggregation'
  | 'composition'
  | 'generalization'
  | 'realization'
  | 'dependency';

/** MIME de dataTransfer que transporta el tipo de nodo arrastrado al controlador drop del lienzo. */
export const PALETTE_DND_MIME = 'application/x-uml-palette';

export interface PaletteProps {
  activeEdgeTool: PaletteEdgeTool | null;
  naryMode: boolean;
  onEdgeToolChange: (tool: PaletteEdgeTool | null) => void;
  onNaryModeToggle: () => void;
  /** unidad 13e.10 — riel solo de iconos (estado perteneciente al lienzo; opcional). */
  collapsed?: boolean;
  /** unidad 13e.10 — renderiza el alternador de encabezado cuando se proporciona. */
  onToggleCollapsed?: () => void;
  /** Comodidad estilo EA: clic directo para colocar un nodo en el lienzo sin forzar arrastre. */
  onNodeClick?: (kind: PaletteNodeKind) => void;
}

const INK = '#1a1a2e';

function ClassGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <rect x="2" y="2" width="40" height="18" fill="#fff" stroke={INK} strokeWidth="2" />
      <line x1="2" y1="9" x2="42" y2="9" stroke={INK} strokeWidth="1" />
    </svg>
  );
}

function InterfaceGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <rect x="2" y="2" width="40" height="18" fill="#fff" stroke={INK} strokeWidth="2" strokeDasharray="4 2" />
      <line x1="2" y1="9" x2="42" y2="9" stroke={INK} strokeWidth="1" />
    </svg>
  );
}

function AssociationGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="42" y2="11" stroke={INK} strokeWidth="2" />
    </svg>
  );
}

/**
 * Glifos de agregación/composición: el diamante se ubica en el extremo
 * DESTINO (derecho), reflejando el aggregationEnd='target' predeterminado de la
 * asociación creada al arrastrar de A hacia B. Hueco = agregación compartida, lleno = composición.
 */
function AggregationGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="30" y2="11" stroke={INK} strokeWidth="2" />
      <path d="M 30 11 L 37 4 L 44 11 L 37 18 Z" fill="#fff" stroke={INK} strokeWidth="2" />
    </svg>
  );
}

function CompositionGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="30" y2="11" stroke={INK} strokeWidth="2" />
      <path d="M 30 11 L 37 4 L 44 11 L 37 18 Z" fill={INK} stroke={INK} strokeWidth="2" />
    </svg>
  );
}

/** Punta de flecha de triángulo hueco (generalización/realización UML). */
function triangle(x: number) {
  return <path d={`M ${x} 3 L ${x + 12} 11 L ${x} 19 Z`} fill="#fff" stroke={INK} strokeWidth="2" />;
}

function GeneralizationGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="30" y2="11" stroke={INK} strokeWidth="2" />
      {triangle(30)}
    </svg>
  );
}

function RealizationGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="30" y2="11" stroke={INK} strokeWidth="2" strokeDasharray="5 3" />
      {triangle(30)}
    </svg>
  );
}

function DependencyGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="11" x2="31" y2="11" stroke={INK} strokeWidth="2" strokeDasharray="5 3" />
      <path d="M 31 3 L 42 11 L 31 19" fill="none" stroke={INK} strokeWidth="2" />
    </svg>
  );
}

function NaryGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <path d="M 22 1 L 41 11 L 22 21 L 3 11 Z" fill="#fff" stroke={INK} strokeWidth="2" />
    </svg>
  );
}

function AssociationClassGlyph() {
  return (
    <svg width="40" height="22" viewBox="0 0 44 22" aria-hidden="true">
      <line x1="2" y1="17" x2="42" y2="17" stroke={INK} strokeWidth="1.5" />
      <line x1="22" y1="17" x2="22" y2="11" stroke={INK} strokeWidth="1.5" strokeDasharray="2 2" />
      <rect x="14" y="2" width="16" height="9" fill="#fff" stroke={INK} strokeWidth="1.5" />
    </svg>
  );
}

const EDGE_TOOLS: ReadonlyArray<{
  tool: PaletteEdgeTool;
  testId: string;
  labelKey: TKey;
  glyph: ReactElement;
}> = [
  { tool: 'association', testId: 'palette-association', labelKey: 'tool.association', glyph: <AssociationGlyph /> },
  { tool: 'associationClass', testId: 'palette-association-class', labelKey: 'tool.associationClass', glyph: <AssociationClassGlyph /> },
  { tool: 'aggregation', testId: 'palette-aggregation', labelKey: 'tool.aggregation', glyph: <AggregationGlyph /> },
  { tool: 'composition', testId: 'palette-composition', labelKey: 'tool.composition', glyph: <CompositionGlyph /> },
  { tool: 'generalization', testId: 'palette-generalization', labelKey: 'tool.generalization', glyph: <GeneralizationGlyph /> },
  { tool: 'realization', testId: 'palette-realization', labelKey: 'tool.realization', glyph: <RealizationGlyph /> },
  { tool: 'dependency', testId: 'palette-dependency', labelKey: 'tool.dependency', glyph: <DependencyGlyph /> },
];

export function Palette({
  activeEdgeTool,
  naryMode,
  onEdgeToolChange,
  onNaryModeToggle,
  collapsed = false,
  onToggleCollapsed,
  onNodeClick,
}: PaletteProps) {
  const { t } = useT();

  const startNodeDrag = (kind: PaletteNodeKind) => (event: DragEvent<HTMLButtonElement>) => {
    event.dataTransfer.setData(PALETTE_DND_MIME, kind);
    event.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <aside
      className={`palette${collapsed ? ' palette--collapsed' : ''}`}
      aria-label={t('toolbox.ariaLabel')}
    >
      {/* unit 13e — tira de encabezado de caja de herramientas acoplada estilo EA + alternador de colapso (13e.10). */}
      <div className="palette__header">
        <span className="palette__header-text">{t('toolbox.header')}</span>
        {onToggleCollapsed !== undefined && (
          <button
            type="button"
            className="palette__toggle"
            data-testid="palette-toggle"
            aria-label={collapsed ? t('toolbox.expand') : t('toolbox.collapse')}
            title={collapsed ? t('toolbox.expand') : t('toolbox.collapse')}
            onClick={onToggleCollapsed}
          >
            {collapsed ? '»' : '«'}
          </button>
        )}
      </div>

      {/* unit 13c — bloque 1: los objetos arrastrables. */}
      <div className="palette__group" role="group" aria-label={t('toolbox.objects')}>
        <span className="palette__group-title">{t('toolbox.objects')}</span>
        <button
          type="button"
          className="palette__item palette__item--node"
          data-testid="palette-class"
          draggable
          onDragStart={startNodeDrag('class')}
          onClick={() => onNodeClick?.('class')}
          aria-label={t('palette.createClassAria')}
          title={t('palette.dragClassTitle')}
        >
          <span className="palette__glyph"><ClassGlyph /></span>
          <span className="palette__label">{t('tool.class')}</span>
        </button>
        <button
          type="button"
          className="palette__item palette__item--node"
          data-testid="palette-interface"
          draggable
          onDragStart={startNodeDrag('interface')}
          onClick={() => onNodeClick?.('interface')}
          aria-label={t('palette.createInterfaceAria')}
          title={t('palette.dragInterfaceTitle')}
        >
          <span className="palette__glyph"><InterfaceGlyph /></span>
          <span className="palette__label">{t('tool.interface')}</span>
        </button>
      </div>

      {/* unidad 13c — bloque 2: cada herramienta de relación, incluyendo el modo n-ario. */}
      <div className="palette__group" role="group" aria-label={t('toolbox.relations')}>
        <span className="palette__group-title">{t('toolbox.relations')}</span>
        {EDGE_TOOLS.map(({ tool, testId, labelKey, glyph }) => {
          const label = t(labelKey);
          return (
            <button
              key={tool}
              type="button"
              className={`palette__item${activeEdgeTool === tool ? ' palette__item--active' : ''}`}
              data-testid={testId}
              aria-label={t('palette.edgeToolAria', { label })}
              aria-pressed={activeEdgeTool === tool}
              title={t('palette.armToolTitle', { label: label.toLowerCase() })}
              onClick={() => onEdgeToolChange(activeEdgeTool === tool ? null : tool)}
            >
              <span className="palette__glyph">{glyph}</span>
              <span className="palette__label">{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          className={`palette__item${naryMode ? ' palette__item--active' : ''}`}
          data-testid="palette-nary"
          aria-label={t('palette.naryAria')}
          aria-pressed={naryMode}
          title={t('palette.naryTitle')}
          onClick={onNaryModeToggle}
        >
          <span className="palette__glyph"><NaryGlyph /></span>
          <span className="palette__label">{t('tool.nary')}</span>
        </button>
      </div>
    </aside>
  );
}
