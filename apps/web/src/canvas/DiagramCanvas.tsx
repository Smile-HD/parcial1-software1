/**
 * DiagramCanvas — lienzo React Flow renderizado exclusivamente desde un Y.Doc.
 *
 * editor:R1 — el Y.Doc ES la IR canónica; el estado de React es una proyección
 * derivada que activa el re-renderizado cuando cambia el Y.Doc.
 * Ninguna mutación evade applyDelta (ver applyDeltaToYDoc).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { ReactFlow, Background, BackgroundVariant, ViewportPortal, applyNodeChanges, type Connection, type Edge, type NodeChange, type ReactFlowInstance, MarkerType } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type * as Y from 'yjs';

import { MultiplicitySchema, projectYDocToDiagram, type ApplyError, type ApplyResult, type Association, type AssociationDelta, type ClassDelta, type DependencyDelta, type Diagram, type Generalization, type GeneralizationDelta, type MemberDelta, type NaryAssociationDelta, type NaryMemberEnd, type Parameter, type Realization, type RealizationDelta } from '@app/core';

import './canvas.css';
import { ClassNode, type ClassNodeData, type ClassFlowNode, type MemberAdornments } from './ClassNode';
import { NaryDiamondNode, type NaryDiamondFlowNode } from './NaryDiamondNode';
import { applyDeltaToYDoc } from './applyDeltaToYDoc';
import { AssociationEdge } from './AssociationEdge';
import { GeneralizationEdge } from './GeneralizationEdge';
import { RealizationEdge } from './RealizationEdge';
import { DependencyEdge } from './DependencyEdge';
import { NaryEndEdge } from './NaryEndEdge';
import { Palette, PALETTE_DND_MIME, type PaletteEdgeTool, type PaletteNodeKind } from './Palette';
import { QuickLinkerMenu } from './QuickLinkerMenu';
import { EdgeCrossingProvider } from './EdgeCrossingContext';
import {
  elementMenuOptions,
  quickLinkerTarget,
  validConnectorsFor,
  type QuickConnectorType,
  type QuickLinkerKind,
} from './quickLinker';
import { t, useT, type TKey } from '../i18n';

const nodeTypes = { class: ClassNode, naryDiamond: NaryDiamondNode };
const edgeTypes = { association: AssociationEdge, generalization: GeneralizationEdge, realization: RealizationEdge, dependency: DependencyEdge, naryEnd: NaryEndEdge };

/**
 * unidad 13c — los tipos de arista que comprende el editor unificado. Las aristas
 * de miembros n-arios (`naryEnd`) quedan deliberadamente excluidas: se editan a través
 * del flujo propio de contexto/selección del diamante n-ario, no del panel individual de aristas.
 */
type EditorEdgeType = 'association' | 'generalization' | 'realization' | 'dependency';

/**
 * unidad 13e.10 — las etiquetas visuales de tipos de aristas provienen del diccionario i18n (el
 * antiguo mapa cableado EDGE_TYPE_LABELS → claves `tool.*`; los valores en EN son
 * idénticos byte a byte, por lo que cada contrato existente de aria-label/testid sobrevive).
 */
const EDGE_TYPE_KEYS: Record<EditorEdgeType, TKey> = {
  association: 'tool.association',
  generalization: 'tool.generalization',
  realization: 'tool.realization',
  dependency: 'tool.dependency',
};

/** unidad 13e.10 — las etiquetas del menú de Quick Linker se asignan a las mismas claves `tool.*`
 * (quickLinker.ts se mantiene puro — el mapeo reside en el sitio de renderizado). */
const CONNECTOR_TOOL_KEYS: Record<QuickConnectorType, TKey> = {
  association: 'tool.association',
  aggregation: 'tool.aggregation',
  composition: 'tool.composition',
  generalization: 'tool.generalization',
  realization: 'tool.realization',
  dependency: 'tool.dependency',
};

const ELEMENT_TOOL_KEYS: Record<PaletteNodeKind, TKey> = {
  class: 'tool.class',
  interface: 'tool.interface',
};

function isEditorEdgeType(type: string | undefined): type is EditorEdgeType {
  return type === 'association' || type === 'generalization' || type === 'realization' || type === 'dependency';
}

export interface DiagramCanvasProps {
  doc: Y.Doc;
}

/**
 * editor:R2 — fin de arrastre: emite un delta de reposicionamiento; el Y.Doc permanece como la fuente de verdad.
 */
export function handleNodeDragStop(
  doc: Y.Doc,
  diagramId: string,
  node: { id: string; position: { x: number; y: number } },
): void {
  const delta: ClassDelta = {
    kind: 'class',
    op: 'reposition',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    classId: node.id,
    newPosition: node.position,
  };
  applyDeltaToYDoc(doc, delta);
}

/** editor:R4 - enlace entre dos clases existentes; las multiplicidades son editables por extremo. */
export interface AssociationLink {
  sourceClassId: string;
  targetClassId: string;
  directed: boolean;
  /**
   * unidad 13c — preajuste de tipo de agregación opcional (herramientas de Agregación /
   * Composición de la paleta). Omitido = asociación simple ('none' mediante el
   * valor predeterminado de la IR), de modo que cada llamador existente permanece idéntico byte a byte.
   */
  aggregation?: 'none' | 'shared' | 'composite';
}

/**
 * editor:R4 - emite un delta `create` de asociación vía applyDeltaToYDoc.
 * Protecciones antes de emitir: el esquema del delta arroja excepción ante entrada inválida,
 * por lo que ningún id de clase vacío lo alcanza. Las asociaciones autorreferenciales (recursivas)
 * — la misma clase en ambos extremos — son UML válido y están permitidas por el motor central
 * (la ruta de arrastrar para conectar de la paleta agrega su propia protección de extremos distintos).
 * unidad 13b: retorna el resultado del motor (null cuando la protección local rechaza)
 * para que la ruta de arrastrar para conectar pueda exponer los rechazos; quienes llaman a esto
 * actualmente ignoran el valor de retorno.
 */
export function handleCreateAssociation(
  doc: Y.Doc,
  diagramId: string,
  link: AssociationLink,
): ApplyResult<Diagram> | null {
  if (link.sourceClassId === '' || link.targetClassId === '') {
    return null;
  }
  // unidad 13d corrección C — los preajustes de Agregación/Composición inician con multiplicidades
  // NO ESPECIFICADAS (extremos vacíos, según la convención UML: un nuevo conector no
  // asume multiplicidad predeterminada). La herramienta de Asociación simple conserva su
  // valor predeterminado documentado '1'/'1'; las rutas comparten esta función pero bifurcan según el preajuste.
  const presetAggregation = link.aggregation !== undefined && link.aggregation !== 'none';
  const delta: AssociationDelta = {
    kind: 'association',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    associationId: crypto.randomUUID(),
    sourceClassId: link.sourceClassId,
    targetClassId: link.targetClassId,
    ...(presetAggregation
      ? {}
      : { sourceMultiplicity: '1', targetMultiplicity: '1' }),
    directed: link.directed,
    // unidad 13c — las herramientas de Agregación/Composición de la paleta preestablecen el tipo;
    // el diamante se ubica en el extremo origen por defecto (aggregationEnd='source').
    ...(presetAggregation
      ? { aggregation: link.aggregation, aggregationEnd: 'source' as const }
      : {}),
  };
  return applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R4 - edición de multiplicidad por extremo, protegida contra valores fuera
 * del enum. La protección reside AQUÍ (antes de emitir): `DeltaSchema.parse` en
 * core ARROJA excepción ante multiplicidades inválidas, por lo que `3..7` nunca debe
 * llegar a applyDeltaToYDoc o la aplicación fallará. La entrada inválida se rechaza
 * silenciosamente y el valor anterior se conserva (no se emite delta).
 * unidad 13d corrección C — un valor VACÍO (o de solo espacios) RESTABLECE el extremo
 * a no especificado mediante un portador `null` (el tri-estado de core: undefined conserva,
 * string establece, null limpia). Los valores basura aún se rechazan.
 */
export function handleUpdateMultiplicity(
  doc: Y.Doc,
  diagramId: string,
  associationId: string,
  endpoint: 'source' | 'target',
  value: string,
): void {
  const trimmed = value.trim();
  if (trimmed === '') {
    // Limpiar a no especificado — el editor debe permitir vaciar una multiplicidad.
    const clearDelta: AssociationDelta = {
      kind: 'association',
      op: 'updateMultiplicity',
      id: crypto.randomUUID(),
      diagramId,
      timestamp: new Date().toISOString(),
      associationId,
      ...(endpoint === 'source'
        ? { newSourceMultiplicity: null }
        : { newTargetMultiplicity: null }),
    };
    applyDeltaToYDoc(doc, clearDelta);
    return;
  }
  // unidad 9 — gramática completa de multiplicidad UML 2.5.1 (*, enteros, m..n, m..*);
  // los valores no válidos se rechazan y el valor anterior se conserva (editor:R4).
  const parsed = MultiplicitySchema.safeParse(trimmed);
  if (!parsed.success) {
    return;
  }
  const multiplicity = parsed.data;
  const delta: AssociationDelta = {
    kind: 'association',
    op: 'updateMultiplicity',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    associationId,
    ...(endpoint === 'source'
      ? { newSourceMultiplicity: multiplicity }
      : { newTargetMultiplicity: multiplicity }),
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * Unidad 10 — actualiza el tipo de agregación, nombre, roles y aggregationEnd de la asociación.
 * Los valores de agregación inválidos se rechazan (no se emite delta).
 */
export function handleUpdateAssociationMeta(
  doc: Y.Doc,
  diagramId: string,
  associationId: string,
  updates: { aggregation?: 'none' | 'shared' | 'composite'; aggregationEnd?: 'source' | 'target'; name?: string; sourceRole?: string; targetRole?: string },
): void {
  // Validar agregación si se proporciona
  if (updates.aggregation !== undefined && !['none', 'shared', 'composite'].includes(updates.aggregation)) {
    return;
  }
  // Validar aggregationEnd si se proporciona
  if (updates.aggregationEnd !== undefined && !['source', 'target'].includes(updates.aggregationEnd)) {
    return;
  }
  const delta: AssociationDelta = {
    kind: 'association',
    op: 'updateMultiplicity', // reutiliza el tipo de op existente para retrocompatibilidad; los campos son opcionales
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    associationId,
    ...(updates.aggregation !== undefined ? { aggregation: updates.aggregation } : {}),
    ...(updates.aggregationEnd !== undefined ? { aggregationEnd: updates.aggregationEnd } : {}),
    ...(updates.name !== undefined ? { name: updates.name || undefined } : {}),
    ...(updates.sourceRole !== undefined ? { sourceRole: updates.sourceRole || undefined } : {}),
    ...(updates.targetRole !== undefined ? { targetRole: updates.targetRole || undefined } : {}),
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R4 — elimina una asociación emitiendo un delta `delete` de asociación.
 * La operación existe en core desde la Unidad 6; esto la conecta a la UI para que
 * las asociaciones puedan eliminarse sin borrar una clase miembro.
 */
export function handleDeleteAssociation(
  doc: Y.Doc,
  diagramId: string,
  associationId: string,
): void {
  const delta: AssociationDelta = {
    kind: 'association',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    associationId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Generalización (unidad 11.4) — emite un delta `create` de generalización
 * (subClass → superClass). Los invariantes del motor (existencia, duplicados, ciclos)
 * son impuestos por applyDelta; un delta rechazado deja el Y.Doc sin cambios.
 * unidad 13b: retorna el resultado del motor para que la ruta de arrastrar para conectar
 * pueda exponer rechazos por ciclo/duplicado; los llamadores existentes lo ignoran.
 */
export function handleCreateGeneralization(
  doc: Y.Doc,
  diagramId: string,
  link: { subClassId: string; superClassId: string },
): ApplyResult<Diagram> | null {
  if (link.subClassId === '' || link.superClassId === '') {
    return null;
  }
  const delta: GeneralizationDelta = {
    kind: 'generalization',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    generalizationId: crypto.randomUUID(),
    subClassId: link.subClassId,
    superClassId: link.superClassId,
  };
  return applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Generalización (unidad 11.4) — emite un delta `delete` de generalización.
 */
export function handleDeleteGeneralization(
  doc: Y.Doc,
  diagramId: string,
  generalizationId: string,
): void {
  const delta: GeneralizationDelta = {
    kind: 'generalization',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    generalizationId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unidad 12.2/12.4) — emite un delta `create` de realización
 * (clase cliente → interfaz proveedora). Los invariantes del motor (existencia,
 * destino de tipo interfaz, duplicados) son impuestos por applyDelta; un delta
 * rechazado deja el Y.Doc sin cambios.
 * unidad 13b: retorna el resultado del motor para que la ruta de arrastrar para conectar
 * pueda exponer rechazos; los llamadores existentes lo ignoran.
 */
export function handleCreateRealization(
  doc: Y.Doc,
  diagramId: string,
  link: { clientClassId: string; supplierInterfaceId: string },
): ApplyResult<Diagram> | null {
  if (link.clientClassId === '' || link.supplierInterfaceId === '') {
    return null;
  }
  const delta: RealizationDelta = {
    kind: 'realization',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    realizationId: crypto.randomUUID(),
    clientClassId: link.clientClassId,
    supplierInterfaceId: link.supplierInterfaceId,
  };
  return applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unidad 12.4) — emite un delta `delete` de realización.
 */
export function handleDeleteRealization(
  doc: Y.Doc,
  diagramId: string,
  realizationId: string,
): void {
  const delta: RealizationDelta = {
    kind: 'realization',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    realizationId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unidad 12.2/12.4 — mitad 12b) — emite un delta
 * `create` de dependencia (clase cliente → clase o interfaz proveedora). Los invariantes
 * del motor (existencia, duplicados) son impuestos por applyDelta; un delta
 * rechazado deja el Y.Doc sin cambios.
 * unidad 13b: retorna el resultado del motor para que la ruta de arrastrar para conectar
 * pueda exponer rechazos; los llamadores existentes lo ignoran.
 */
export function handleCreateDependency(
  doc: Y.Doc,
  diagramId: string,
  link: { clientClassId: string; supplierClassId: string },
): ApplyResult<Diagram> | null {
  if (link.clientClassId === '' || link.supplierClassId === '') {
    return null;
  }
  const delta: DependencyDelta = {
    kind: 'dependency',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    dependencyId: crypto.randomUUID(),
    clientClassId: link.clientClassId,
    supplierClassId: link.supplierClassId,
  };
  return applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unidad 12.4 — mitad 12b) — emite un delta `delete` de dependencia.
 */
export function handleDeleteDependency(
  doc: Y.Doc,
  diagramId: string,
  dependencyId: string,
): void {
  const delta: DependencyDelta = {
    kind: 'dependency',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    dependencyId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * unidad 13c — actualiza la etiqueta editable de una generalización vía el delta de nombre
 * `update` de core. Una cadena vacía borra la etiqueta (el motor mapea '' → undefined).
 */
export function handleUpdateGeneralizationLabel(
  doc: Y.Doc,
  diagramId: string,
  generalizationId: string,
  name: string,
): void {
  const delta: GeneralizationDelta = {
    kind: 'generalization',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    generalizationId,
    name,
  };
  applyDeltaToYDoc(doc, delta);
}

/** unidad 13c — actualiza la etiqueta editable de una realización (ver gemelo de generalización). */
export function handleUpdateRealizationLabel(
  doc: Y.Doc,
  diagramId: string,
  realizationId: string,
  name: string,
): void {
  const delta: RealizationDelta = {
    kind: 'realization',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    realizationId,
    name,
  };
  applyDeltaToYDoc(doc, delta);
}

/** unidad 13c — actualiza la etiqueta editable de una dependencia (ver gemelo de generalización). */
export function handleUpdateDependencyLabel(
  doc: Y.Doc,
  diagramId: string,
  dependencyId: string,
  name: string,
): void {
  const delta: DependencyDelta = {
    kind: 'dependency',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    dependencyId,
    name,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R N-aria (unidad 13.2) — centroide de las posiciones de las clases miembros.
 * El nodo diamante se posiciona aquí y se vuelve a derivar en cada proyección,
 * por lo que siempre se ubica en el centro de sus miembros (nunca arrastrado por el usuario).
 * Una lista vacía de miembros degenera al origen (defensivo únicamente: el
 * motor garantiza >=3 extremos).
 */
export function computeNaryCentroid(
  positions: readonly { x: number; y: number }[],
): { x: number; y: number } {
  if (positions.length === 0) {
    return { x: 0, y: 0 };
  }
  const sum = positions.reduce((acc, p) => ({ x: acc.x + p.x, y: acc.y + p.y }), { x: 0, y: 0 });
  return { x: sum.x / positions.length, y: sum.y / positions.length };
}

/** Un extremo miembro según se ingresa en la UI del editor n-ario. */
export interface NaryMemberEndInput {
  classId: string;
  multiplicity: string;
  role?: string;
}

/**
 * editor:R N-aria (unidad 13.2/13.3) — emite un delta `create` de naryAssociation.
 * Protecciones ANTES de emitir (DeltaSchema.parse arroja excepción, por lo que basura nunca
 * debe llegar a applyDeltaToYDoc): menos de tres extremos son rechazados, y cada
 * multiplicidad debe satisfacer MultiplicitySchema. Los invariantes del motor (existencia
 * de miembros, extremos duplicados) son impuestos por applyDelta; un delta rechazado
 * deja el Y.Doc sin cambios.
 */
export function handleCreateNaryAssociation(
  doc: Y.Doc,
  diagramId: string,
  input: { memberEnds: NaryMemberEndInput[]; name?: string },
): void {
  if (input.memberEnds.length < 3) {
    return;
  }
  const memberEnds: NaryMemberEnd[] = [];
  for (const end of input.memberEnds) {
    if (end.classId === '') {
      return;
    }
    const parsed = MultiplicitySchema.safeParse(end.multiplicity);
    if (!parsed.success) {
      return;
    }
    memberEnds.push({
      classId: end.classId,
      multiplicity: parsed.data,
      ...(end.role !== undefined && end.role !== '' ? { role: end.role } : {}),
    });
  }
  const delta: NaryAssociationDelta = {
    kind: 'naryAssociation',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    naryAssociationId: crypto.randomUUID(),
    memberEnds,
    ...(input.name !== undefined && input.name !== '' ? { name: input.name } : {}),
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R N-aria (unidad 13d corrección A) — emite un delta `update` de naryAssociation
 * (las confirmaciones del editor de diamante). Mismas protecciones previas a la emisión que create:
 * menos de tres extremos o una multiplicidad inválida nunca alcanzan el parseo del esquema que
 * arroja excepción; una entrada rechazada no emite NADA (se conserva el valor anterior). `name`
 * acepta una cadena vacía para LIMPIAR la etiqueta (el motor mapea '' → undefined).
 */
export function handleUpdateNaryAssociation(
  doc: Y.Doc,
  diagramId: string,
  naryAssociationId: string,
  updates: { name?: string; memberEnds?: NaryMemberEndInput[] },
): void {
  if (updates.name === undefined && updates.memberEnds === undefined) {
    return;
  }
  const delta: NaryAssociationDelta = {
    kind: 'naryAssociation',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    naryAssociationId,
    ...(updates.name !== undefined ? { name: updates.name } : {}),
  };
  if (updates.memberEnds !== undefined) {
    if (updates.memberEnds.length < 3) {
      return;
    }
    const memberEnds: NaryMemberEnd[] = [];
    for (const end of updates.memberEnds) {
      if (end.classId === '') {
        return;
      }
      const parsed = MultiplicitySchema.safeParse(end.multiplicity);
      if (!parsed.success) {
        return;
      }
      memberEnds.push({
        classId: end.classId,
        multiplicity: parsed.data,
        ...(end.role !== undefined && end.role !== '' ? { role: end.role } : {}),
      });
    }
    delta.memberEnds = memberEnds;
  }
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R N-aria (unidad 13.3) — emite un delta `delete` de naryAssociation
 * (la acción del menú contextual del diamante).
 */
export function handleDeleteNaryAssociation(
  doc: Y.Doc,
  diagramId: string,
  naryAssociationId: string,
): void {
  const delta: NaryAssociationDelta = {
    kind: 'naryAssociation',
    op: 'delete',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    naryAssociationId,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * editor:R Interfaces (unidad 12.4) — conmuta la marca abstracta vía un delta
 * `update` de clase que transporta isAbstract.
 */
export function handleSetAbstract(
  doc: Y.Doc,
  diagramId: string,
  classId: string,
  isAbstract: boolean,
): void {
  const delta: ClassDelta = {
    kind: 'class',
    op: 'update',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    classId,
    isAbstract,
  };
  applyDeltaToYDoc(doc, delta);
}

/**
 * Primer auto-nombre libre: Class1, Class2, ... (o Interface1, ... con un
 * prefijo personalizado) omitiendo cualquier nombre existente.
 */
function nextFreeClassName(existing: readonly string[], prefix = 'Class'): string {
  let n = 1;
  while (existing.includes(`${prefix}${n}`)) {
    n += 1;
  }
  return `${prefix}${n}`;
}

/**
 * unidad 13b (editor:R CRUD de Elemento Clase / Interfaces) — soltar de la paleta:
 * crea un nodo de clase/interfaz en la posición del lienzo donde se soltó el
 * elemento. Emite el MISMO delta `create` de clase que usan los botones de la barra de
 * herramientas (las interfaces transportan classKind), parametrizado por posición de soltado + tipo, con
 * el siguiente auto-nombre libre. Los controladores de la barra de herramientas delegan aquí para que haya
 * exactamente una ruta de creación.
 * unidad 13d — retorna el classId creado para que el gesto de elemento+conector
 * del Quick Linker pueda encadenar el delta del conector sobre el elemento
 * que acaba de crear. Los llamadores existentes ignoran el valor de retorno.
 */
export function handlePaletteDrop(
  doc: Y.Doc,
  diagramId: string,
  input: { kind: PaletteNodeKind; position: { x: number; y: number }; existingNames: readonly string[] },
): string {
  const prefix = input.kind === 'interface' ? 'Interface' : 'Class';
  const name = nextFreeClassName(input.existingNames, prefix);
  const classId = crypto.randomUUID();
  const delta: ClassDelta = {
    kind: 'class',
    op: 'create',
    id: crypto.randomUUID(),
    diagramId,
    timestamp: new Date().toISOString(),
    classId,
    name,
    position: input.position,
    ...(input.kind === 'interface' ? { classKind: 'interface' as const } : {}),
  };
  applyDeltaToYDoc(doc, delta);
  return classId;
}

/** Resultado de un arrastrar para conectar protegido: ok, o rechazado con un mensaje para el usuario. */
export interface ConnectGuardResult {
  ok: boolean;
  message?: string;
}

/**
 * Razón legible por humanos para un rechazo del motor mostrada en la UI.
 * unidad 13e.10 — `t()` a nivel de módulo en tiempo de LLAMADA: estos se ejecutan dentro
 * de controladores de eventos (no de renderizado), y `t` lee el idioma actual en cada llamada.
 */
function describeApplyError(error: ApplyError): string {
  switch (error.kind) {
    case 'GeneralizationCycleError':
      return t('reason.cycle');
    case 'DuplicateGeneralizationError':
      return t('reason.duplicateGeneralization');
    case 'RealizationTargetNotInterfaceError':
      return t('reason.realizationNotInterface');
    case 'DuplicateRealizationError':
      return t('reason.duplicateRealization');
    case 'DuplicateDependencyError':
      return t('reason.duplicateDependency');
    case 'ClassNotFoundError':
      return t('reason.classNotFound');
    default:
      return t('reason.unknown');
  }
}

function engineGuardResult(result: ApplyResult<Diagram> | null, label: string): ConnectGuardResult {
  if (result === null) {
    return { ok: false, message: t('guard.invalidEndpoints', { label }) };
  }
  if (result.ok) {
    return { ok: true };
  }
  return { ok: false, message: t('guard.rejectedReason', { label, reason: describeApplyError(result.error) }) };
}

/**
 * unidad 13b (editor:R Asociaciones/Generalización/Realización/Dependencia) —
 * el núcleo de arrastrar para conectar: dada la herramienta de arista ARMADA y una
 * conexión de React Flow (nodo origen → nodo destino), impone los invariantes de nivel de UI
 * que el motor también impone (para que el usuario vea un mensaje claro en lugar de una
 * falla silenciosa) y emite el delta correspondiente con los nombres de campo correctos:
 *  - association:    sourceClassId/targetClassId, clases existentes distintas
 *  - aggregation:    asociación con preajuste aggregation='shared' (13c)
 *  - composition:    asociación con preajuste aggregation='composite' (13c)
 *  - generalization: subClassId=origen → superClassId=destino (los ciclos son
 *                    rechazados por el motor; el rechazo se expone)
 *  - realization:    clientClassId=origen → supplierInterfaceId=destino,
 *                    el destino DEBE ser una interfaz
 *  - dependency:     clientClassId=origen → supplierClassId=destino (el
 *                    proveedor puede ser cualquier clasificador, clase o interfaz)
 * Sin ninguna herramienta armada se ignora la conexión — sin aristas accidentales.
 */
export function handleConnectWithTool(
  doc: Y.Doc,
  diagramId: string,
  tool: PaletteEdgeTool | null,
  connection: { source: string | null; target: string | null },
  classifiers: readonly { id: string; kind: 'class' | 'interface' }[],
): ConnectGuardResult {
  if (tool === null) {
    return { ok: false };
  }
  const { source, target } = connection;
  if (source === null || target === null) {
    return { ok: false, message: t('guard.bothEndsClasses') };
  }
  const sourceCls = classifiers.find((cls) => cls.id === source);
  const targetCls = classifiers.find((cls) => cls.id === target);
  if (sourceCls === undefined || targetCls === undefined) {
    return { ok: false, message: t('guard.endpointsExist') };
  }

  switch (tool) {
    case 'association': {
      // La autoasociación es UML válido (ej., Empleado→gestiona→Empleado)
      const result = handleCreateAssociation(doc, diagramId, {
        sourceClassId: source,
        targetClassId: target,
        directed: false,
      });
      return engineGuardResult(result, t('tool.association'));
    }
    // unidad 13c — Agregación/Composición reutilizan la ruta de asociación con el
    // tipo de diamante preestablecido (shared = hueco, composite = lleno).
    case 'aggregation':
    case 'composition': {
      // La autoagregación/composición es UML válido (ej., TreeNode compuesto por TreeNode)
      const result = handleCreateAssociation(doc, diagramId, {
        sourceClassId: source,
        targetClassId: target,
        directed: false,
        aggregation: tool === 'aggregation' ? 'shared' : 'composite',
      });
      return engineGuardResult(result, tool === 'aggregation' ? t('tool.aggregation') : t('tool.composition'));
    }
    case 'generalization': {
      if (source === target) {
        return { ok: false, message: t('guard.noSelfInheritance') };
      }
      const result = handleCreateGeneralization(doc, diagramId, {
        subClassId: source,
        superClassId: target,
      });
      return engineGuardResult(result, t('tool.generalization'));
    }
    case 'realization': {
      if (targetCls.kind !== 'interface') {
        return { ok: false, message: t('guard.realizationTarget') };
      }
      const result = handleCreateRealization(doc, diagramId, {
        clientClassId: source,
        supplierInterfaceId: target,
      });
      return engineGuardResult(result, t('tool.realization'));
    }
    case 'dependency': {
      // La autodependencia es UML válido
      const result = handleCreateDependency(doc, diagramId, {
        clientClassId: source,
        supplierClassId: target,
      });
      return engineGuardResult(result, t('tool.dependency'));
    }
  }
}

/**
 * unidad 13d — Quick Linker estilo EA: el menú abierto cuando finaliza el arrastre
 * de enlace rápido. 'connector' = soltado sobre un elemento existente (el menú lista los
 * conectores válidos origen→destino); 'element' = soltado sobre lienzo vacío (el menú lista
 * los tipos creables; seleccionar uno crea el elemento EN el punto de soltado y luego
 * encadena hacia el menú de conectores — elemento+conector en un solo gesto).
 * `anchor` es el punto en pantalla donde se renderiza el menú; `dropPosition` es el
 * punto en coordenadas de flujo donde se crea el nuevo elemento.
 */
type QuickLinkerMenuState =
  | {
      mode: 'connector';
      anchor: { x: number; y: number };
      sourceId: string;
      sourceKind: QuickLinkerKind;
      targetId: string;
      targetKind: QuickLinkerKind;
    }
  | {
      mode: 'element';
      anchor: { x: number; y: number };
      sourceId: string;
      sourceKind: QuickLinkerKind;
      dropPosition: { x: number; y: number };
    };

export function DiagramCanvas({ doc }: DiagramCanvasProps) {
  // unidad 13e.10 — accesor reactivo: cada cadena JSX a continuación se re-renderiza en vivo
  // cuando cambia el alternador de idioma (`t` a nivel de módulo atiende los controladores).
  const { t: tr } = useT();
  // Derivar estado a partir del Y.Doc — el Y.Doc es la fuente de verdad.
  const [diagram, setDiagram] = useState<Diagram>(() => projectYDocToDiagram(doc));

  // unidad 13e.11 — el lienzo posee el estado de colapso de la caja de herramientas (el botón
  // alternador solo se renderiza cuando se pasa onToggleCollapsed).
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  // unidad 13c — UN solo editor para cada tipo de arista: el id + tipo de la arista seleccionada.
  const [selectedEdge, setSelectedEdge] = useState<{ id: string; type: EditorEdgeType } | null>(null);
  // unidad 13d corrección A — el propio editor del diamante n-ario: el id n-ario seleccionado.
  // Resuelto a partir de la proyección en vivo, de modo que eliminar el n-ario cierra el panel.
  const [selectedNaryId, setSelectedNaryId] = useState<string | null>(null);
  // Unidad 11.4 — la clase cuya lista de generalización se muestra en el panel.
  const [selectedClassId, setSelectedClassId] = useState<string | null>(null);
  // Unidad 13.3 — modo de asociación n-aria: seleccionar >=3 clases, multiplicidad por extremo.
  const [naryMode, setNaryMode] = useState(false);
  const [narySelection, setNarySelection] = useState<string[]>([]);
  const [naryEnds, setNaryEnds] = useState<Record<string, string>>({});
  const [naryName, setNaryName] = useState('');
  // Unidad 13b — herramienta de arista armada desde la paleta; null significa que las conexiones están
  // deshabilitadas completamente (sin aristas accidentales). edgeMessage expone rechazos
  // de guardia/motor de la ruta de arrastrar para conectar.
  const [edgeTool, setEdgeTool] = useState<PaletteEdgeTool | null>(null);
  const [edgeMessage, setEdgeMessage] = useState<string | null>(null);
  // Instancia de React Flow (vía onInit) — provee screenToFlowPosition para soltados.
  const rfRef = useRef<ReactFlowInstance | null>(null);
  // unidad 13d — Quick Linker: extremos de arrastre en vivo (coords de pantalla, para la
  // banda elástica) y el menú abierto cuando finaliza el arrastre.
  const [quickLinkDrag, setQuickLinkDrag] = useState<{
    start: { x: number; y: number };
    cursor: { x: number; y: number };
  } | null>(null);
  const [quickLinkMenu, setQuickLinkMenu] = useState<QuickLinkerMenuState | null>(null);

  useEffect(() => {
    const sync = (): void => {
      setDiagram(projectYDocToDiagram(doc));
    };
    doc.on('update', sync);
    return () => {
      doc.off('update', sync);
    };
  }, [doc]);

  // Límite visual de página/lienzo estilo Enterprise Architect (área de trabajo delimitada):
  // Garantiza al menos una hoja estándar (3200 x 2200 px), expandiéndose suavemente si existen
  // elementos situados más allá de estos márgenes.
  const canvasBoundary = useMemo(() => {
    let minX = 0;
    let minY = 0;
    let maxX = 3200;
    let maxY = 2200;

    for (const cls of diagram.classes) {
      if (cls.position.x - 100 < minX) minX = Math.floor((cls.position.x - 100) / 20) * 20;
      if (cls.position.y - 100 < minY) minY = Math.floor((cls.position.y - 100) / 20) * 20;
      if (cls.position.x + 360 > maxX) maxX = Math.ceil((cls.position.x + 360) / 20) * 20;
      if (cls.position.y + 260 > maxY) maxY = Math.ceil((cls.position.y + 260) / 20) * 20;
    }

    return {
      left: minX,
      top: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }, [diagram.classes]);

  /** unidad 13b — permitir soltar elementos de la paleta sobre el lienzo. */
  const onDragOver = useCallback((event: DragEvent): void => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  }, []);

  /**
   * unidad 13b — soltar de la paleta: lee el tipo de nodo arrastrado desde
   * dataTransfer, convierte el punto de pantalla a coordenadas de flujo (ajustado
   * a la cuadrícula de 20px estilo EA), y emite el delta de creación de clase/interfaz.
   */
  const onDrop = useCallback(
    (event: DragEvent): void => {
      event.preventDefault();
      if (event.dataTransfer === undefined || event.dataTransfer === null) {
        return;
      }
      const kind = event.dataTransfer.getData(PALETTE_DND_MIME);
      if (kind !== 'class' && kind !== 'interface') {
        return;
      }
      const screenPos = { x: event.clientX, y: event.clientY };
      // screenToFlowPosition necesita un viewport medido; antes de que React Flow se haya
      // dispuesto (o en contenedores de prueba de tamaño cero) puede retornar NaN — recurre
      // al punto crudo de pantalla para que un soltado nunca emita un delta inválido.
      let position = screenPos;
      if (rfRef.current !== null) {
        const flow = rfRef.current.screenToFlowPosition(screenPos);
        if (Number.isFinite(flow.x) && Number.isFinite(flow.y)) {
          position = {
            x: Math.round(flow.x / 20) * 20,
            y: Math.round(flow.y / 20) * 20,
          };
        }
      }
      handlePaletteDrop(doc, diagram.id, {
        kind,
        position,
        existingNames: diagram.classes.map((cls) => cls.name),
      });
    },
    [doc, diagram],
  );

  /**
   * Comodidad estilo EA: clic directo en la paleta para colocar un clasificador
   * centrado en el viewport sin forzar el gesto de arrastre.
   */
  const handlePaletteQuickAdd = useCallback(
    (kind: PaletteNodeKind): void => {
      const live = projectYDocToDiagram(doc);
      let position = { x: 200, y: 160 };
      if (rfRef.current !== null) {
        const container = document.querySelector('.diagram-canvas .react-flow');
        if (container !== null) {
          const rect = container.getBoundingClientRect();
          const centerScreen = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          const flowPos = rfRef.current.screenToFlowPosition(centerScreen);
          if (Number.isFinite(flowPos.x) && Number.isFinite(flowPos.y)) {
            position = {
              x: Math.round(flowPos.x / 20) * 20,
              y: Math.round(flowPos.y / 20) * 20,
            };
          }
        }
      }
      while (
        live.classes.some(
          (c) => Math.abs(c.position.x - position.x) < 20 && Math.abs(c.position.y - position.y) < 20,
        )
      ) {
        position.x += 40;
        position.y += 40;
      }
      const newId = handlePaletteDrop(doc, live.id, {
        kind,
        position,
        existingNames: live.classes.map((cls) => cls.name),
      });
      setSelectedClassId(newId);
    },
    [doc],
  );

  /**
   * unidad 13b — conexión de React Flow completada mientras una herramienta de arista está armada:
   * delega al controlador protegido y expone cualquier mensaje de rechazo. En caso
   * de éxito la herramienta se desarma automáticamente (un solo uso); en caso de rechazo permanece armada
   * para que el usuario pueda reintentar. Escape o hacer clic en el ítem de la paleta nuevamente
   * también la desarma.
   */
  const onConnect = useCallback(
    (connection: Connection): void => {
      const result = handleConnectWithTool(
        doc,
        diagram.id,
        edgeTool,
        { source: connection.source ?? null, target: connection.target ?? null },
        diagram.classes.map((cls) => ({ id: cls.id, kind: cls.kind ?? ('class' as const) })),
      );
      setEdgeMessage(result.ok ? null : (result.message ?? null));
      if (result.ok) {
        setEdgeTool(null);
      }
    },
    [doc, diagram, edgeTool],
  );

  /**
   * unidad 13d — Quick Linker estilo EA, resolución de soltado. Dado el punto de pantalla
   * en pointer-up: convierte a coordenadas de flujo (misma protección de finitud que el
   * soltado de paleta), prueba impacto en los nodos de clase (tamaño medido cuando React Flow
   * tiene uno — jsdom nunca mide, por lo que aplica la caja predeterminada), luego abre
   * el menú de conectores sobre un elemento o el menú de elementos sobre lienzo
   * vacío. Soltar de vuelta sobre el propio origen abre el menú de conectores
   * con conectores válidos para autoenlace (asociación/agregación/composición/dependencia;
   * generalización excluida porque la autoherencia es un ciclo).
   */
  const finishQuickLink = (sourceId: string, cursor: { x: number; y: number }): void => {
    // El Y.Doc es la fuente de verdad: resolver todo desde una proyección
    // FRESCA para que una edición colaborativa durante el arrastre nunca quede obsoleta.
    const live = projectYDocToDiagram(doc);
    let dropPoint = cursor;
    if (rfRef.current !== null) {
      const flow = rfRef.current.screenToFlowPosition(cursor);
      if (Number.isFinite(flow.x) && Number.isFinite(flow.y)) {
        dropPoint = flow;
      }
    }
    const measuredById = new Map((rfRef.current?.getNodes() ?? []).map((n) => [n.id, n.measured]));
    const hitNodes = live.classes.map((cls) => ({
      id: cls.id,
      position: cls.position,
      width: measuredById.get(cls.id)?.width,
      height: measuredById.get(cls.id)?.height,
    }));
    const sourceKind = (live.classes.find((cls) => cls.id === sourceId)?.kind ?? 'class') as QuickLinkerKind;
    const targetId = quickLinkerTarget(dropPoint, hitNodes);
    if (targetId === null) {
      setQuickLinkMenu({ mode: 'element', anchor: cursor, sourceId, sourceKind, dropPosition: dropPoint });
      return;
    }
    if (targetId === sourceId) {
      // Autoenlace: abrir menú de conectores con conectores válidos para autoenlace (excluye generalización)
      const targetKind = sourceKind;
      setQuickLinkMenu({ mode: 'connector', anchor: cursor, sourceId, sourceKind, targetId, targetKind });
      return;
    }
    const targetKind = (live.classes.find((cls) => cls.id === targetId)?.kind ?? 'class') as QuickLinkerKind;
    setQuickLinkMenu({ mode: 'connector', anchor: cursor, sourceId, sourceKind, targetId, targetKind });
  };

  /**
   * unidad 13d — pointer-down en la flecha de la esquina del nodo seleccionado inicia el
   * arrastre de enlace rápido: una delgada banda elástica sigue al cursor (oyentes a nivel
   * de ventana, removidos en pointer-up) y el soltado es resuelto por
   * `finishQuickLink`. Esta es la ruta rápida estilo EA; la ruta 13c de armar herramienta +
   * arrastrar cuerpo permanece completamente intacta.
   */
  const startQuickLink = (sourceId: string, clientX: number, clientY: number): void => {
    const start = { x: clientX, y: clientY };
    setQuickLinkDrag({ start, cursor: start });
    setQuickLinkMenu(null);
    const onMove = (event: MouseEvent): void => {
      setQuickLinkDrag((prev) =>
        prev === null ? prev : { ...prev, cursor: { x: event.clientX, y: event.clientY } },
      );
    };
    const onUp = (event: MouseEvent): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setQuickLinkDrag(null);
      finishQuickLink(sourceId, { x: event.clientX, y: event.clientY });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /**
   * unidad 13d — elegir un conector del menú de Quick Linker: delega al
   * MISMO despachador protegido que utiliza la ruta de arrastrar para conectar
   * (`handleConnectWithTool`), de modo que cada protección de UI/motor (extremos distintos,
   * interfaz en realización, ciclos, duplicados) se aplica textualmente y
   * los rechazos se muestran a través del canal de mensajes existente.
   */
  const pickQuickConnector = (tool: QuickConnectorType): void => {
    if (quickLinkMenu === null || quickLinkMenu.mode !== 'connector') {
      return;
    }
    const live = projectYDocToDiagram(doc);
    const result = handleConnectWithTool(
      doc,
      live.id,
      tool,
      { source: quickLinkMenu.sourceId, target: quickLinkMenu.targetId },
      live.classes.map((cls) => ({ id: cls.id, kind: cls.kind ?? ('class' as const) })),
    );
    setEdgeMessage(result.ok ? null : (result.message ?? null));
    setQuickLinkMenu(null);
  };

  /**
   * unidad 13d — elegir Class/Interface del menú de elementos: crea el
   * elemento en el punto de soltado (ruta compartida de creación `handlePaletteDrop`),
   * luego encadena directamente al menú de conectores para origen→nuevo elemento —
   * elemento + conector en un solo gesto, exactamente como EA.
   */
  const pickQuickElement = (kind: string): void => {
    if (quickLinkMenu === null || quickLinkMenu.mode !== 'element') {
      return;
    }
    const nodeKind: PaletteNodeKind = kind === 'interface' ? 'interface' : 'class';
    const live = projectYDocToDiagram(doc);
    const newId = handlePaletteDrop(doc, live.id, {
      kind: nodeKind,
      position: quickLinkMenu.dropPosition,
      existingNames: live.classes.map((cls) => cls.name),
    });
    setQuickLinkMenu({
      mode: 'connector',
      anchor: quickLinkMenu.anchor,
      sourceId: quickLinkMenu.sourceId,
      sourceKind: quickLinkMenu.sourceKind,
      targetId: newId,
      targetKind: nodeKind,
    });
  };

  const handleRename = (classId: string, newName: string): void => {
    const delta: ClassDelta = {
      kind: 'class',
      op: 'rename',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      newName,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const handleDeleteClass = (classId: string): void => {
    const delta: ClassDelta = {
      kind: 'class',
      op: 'delete',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
    };
    applyDeltaToYDoc(doc, delta);
  };

  /**
   * unidad 13e.7 — el antiguo modo de clic para enlazar DESAPARECIÓ (las herramientas
   * de arista de la paleta + Quick Linker lo reemplazaron). El clic en nodo ahora solo
   * controla el modo de selección n-ario y la selección exclusiva del editor.
   */
  const handleNodeClick = (node: { id: string; type?: string }): void => {
    // Unidad 13.3 — modo n-ario: hacer clic en clases acumula la selección
    // de miembros (hacer clic nuevamente para retirarlo). El diamante en sí no es
    // un miembro seleccionable; solo participan los nodos de clase.
    if (naryMode) {
      if (node.type !== 'class') return;
      setNarySelection((prev) =>
        prev.includes(node.id) ? prev.filter((id) => id !== node.id) : [...prev, node.id],
      );
      return;
    }
    // unidad 13d corrección A — hacer clic en el diamante n-ario lo selecciona y abre su
    // editor (nombre + multiplicidades por extremo + eliminar), al igual que cualquier otro
    // elemento. El editor de arista es exclusivo: solo un editor a la vez.
    if (node.type === 'naryDiamond') {
      setSelectedNaryId(node.id);
      setSelectedEdge(null);
      return;
    }
    // Un clic en clase cierra el editor n-ario (la selección es exclusiva).
    setSelectedNaryId(null);
  };

  /** Unidad 13.3 — confirma la asociación n-aria desde el panel del editor. */
  const handleCreateNaryFromPanel = (): void => {
    const memberEnds: NaryMemberEndInput[] = narySelection
      .filter((classId) => diagram.classes.some((cls) => cls.id === classId))
      .map((classId) => ({
        classId,
        multiplicity: naryEnds[classId] ?? '1',
      }));
    handleCreateNaryAssociation(doc, diagram.id, {
      memberEnds,
      ...(naryName.trim() !== '' ? { name: naryName.trim() } : {}),
    });
    setNaryMode(false);
    setNarySelection([]);
    setNaryEnds({});
    setNaryName('');
  };

  const handleAddAttribute = (classId: string, name: string, type: string, adornments?: MemberAdornments): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'addAttribute',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId: crypto.randomUUID(),
      name,
      type,
      ...adornments,
    };
    applyDeltaToYDoc(doc, delta);
  };

  /** editor:R3 — edición in situ de atributo emitida como un delta `editAttribute`. */
  const handleEditAttribute = (classId: string, memberId: string, name: string, type: string, adornments?: MemberAdornments): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'editAttribute',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId,
      name,
      type,
      ...adornments,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const handleRemoveAttribute = (classId: string, memberId: string): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'deleteAttribute',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const handleAddMethod = (
    classId: string,
    name: string,
    returnType: string,
    parameters: Parameter[],
    adornments?: MemberAdornments,
  ): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'addMethod',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId: crypto.randomUUID(),
      name,
      returnType,
      parameters,
      ...adornments,
    };
    applyDeltaToYDoc(doc, delta);
  };

  /** editor:R3 — edición in situ de método emitida como un delta `editMethod`. */
  const handleEditMethod = (
    classId: string,
    memberId: string,
    name: string,
    returnType: string,
    parameters: Parameter[],
    adornments?: MemberAdornments,
  ): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'editMethod',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId,
      name,
      returnType,
      parameters,
      ...adornments,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const handleRemoveMethod = (classId: string, memberId: string): void => {
    const delta: MemberDelta = {
      kind: 'member',
      op: 'deleteMethod',
      id: crypto.randomUUID(),
      diagramId: diagram.id,
      timestamp: new Date().toISOString(),
      classId,
      memberId,
    };
    applyDeltaToYDoc(doc, delta);
  };

  const nodes = useMemo<(ClassFlowNode | NaryDiamondFlowNode)[]>(
    () => [
      ...diagram.classes.map((cls) => ({
        id: cls.id,
        type: 'class' as const,
        position: cls.position,
        data: {
          name: cls.name,
          attributes: cls.attributes,
          methods: cls.methods,
          kind: cls.kind ?? 'class',
          isAbstract: cls.isAbstract ?? false,
          otherClasses: diagram.classes
            .filter((other) => other.id !== cls.id)
            .map((other) => ({ id: other.id, name: other.name })),
          otherInterfaces: diagram.classes
            .filter((other) => other.id !== cls.id && (other.kind ?? 'class') === 'interface')
            .map((other) => ({ id: other.id, name: other.name })),
          onRename: (newName: string) => handleRename(cls.id, newName),
          onDelete: () => handleDeleteClass(cls.id),
          onAddAttribute: (name: string, type: string, adornments?: MemberAdornments) =>
            handleAddAttribute(cls.id, name, type, adornments),
          onEditAttribute: (memberId: string, name: string, type: string, adornments?: MemberAdornments) =>
            handleEditAttribute(cls.id, memberId, name, type, adornments),
          onRemoveAttribute: (memberId: string) => handleRemoveAttribute(cls.id, memberId),
          onAddMethod: (name: string, returnType: string, parameters: Parameter[], adornments?: MemberAdornments) =>
            handleAddMethod(cls.id, name, returnType, parameters, adornments),
          onEditMethod: (memberId: string, name: string, returnType: string, parameters: Parameter[], adornments?: MemberAdornments) =>
            handleEditMethod(cls.id, memberId, name, returnType, parameters, adornments),
          onRemoveMethod: (memberId: string) => handleRemoveMethod(cls.id, memberId),
          onMakeSubclass: (superClassId: string) =>
            handleCreateGeneralization(doc, diagram.id, { subClassId: cls.id, superClassId }),
          onToggleAbstract: (isAbstract: boolean) => handleSetAbstract(doc, diagram.id, cls.id, isAbstract),
          onRealize: (supplierInterfaceId: string) =>
            handleCreateRealization(doc, diagram.id, { clientClassId: cls.id, supplierInterfaceId }),
          onDependOn: (supplierClassId: string) =>
            handleCreateDependency(doc, diagram.id, { clientClassId: cls.id, supplierClassId }),
          onSelect: () => setSelectedClassId(cls.id),
          // unidad 13c — mientras una herramienta de arista está armada, el cuerpo del nodo
          // se convierte en un inicio de conexión válido (conector superpuesto en todo el nodo).
          connectArmed: edgeTool !== null,
          // unidad 13d — la flecha de Quick Linker se renderiza solo en el nodo
          // seleccionado; pointer-down sobre ella inicia el arrastre de enlace rápido.
          selected: selectedClassId === cls.id,
          onQuickLinkStart: (clientX: number, clientY: number) => startQuickLink(cls.id, clientX, clientY),
        } satisfies ClassNodeData,
      })),
      // Unidad 13.2 — un nodo diamante por asociación n-aria, posicionado en el
      // centroide de sus clases miembros y vuelto a derivar en cada proyección
      // (draggable: false — el centroide ES su posición).
      ...(diagram.naryAssociations ?? [])
        .map((nary) => {
          const memberPositions = nary.memberEnds
            .map((end) => diagram.classes.find((cls) => cls.id === end.classId)?.position)
            .filter((pos): pos is { x: number; y: number } => pos !== undefined);
          if (memberPositions.length === 0) return null;
          return {
            id: nary.id,
            type: 'naryDiamond' as const,
            position: computeNaryCentroid(memberPositions),
            draggable: false,
            data: {
              nary,
              onDelete: () => handleDeleteNaryAssociation(doc, diagram.id, nary.id),
            },
          } satisfies NaryDiamondFlowNode;
        })
        .filter((node): node is NaryDiamondFlowNode => node !== null),
    ],
    // unidad 13c — edgeTool se une a las dependencias: armar/desarmar conmuta las
    // superposiciones de conexión en todo el nodo. unidad 13d — selectedClassId conmuta la
    // flecha de la esquina de Quick Linker.
    [diagram, edgeTool, selectedClassId],
  );

  // unidad 13e.19 — transmisión colaborativa en vivo de arrastre (60/120 FPS).
  // Sincroniza las coordenadas en tiempo real al Y.Doc mediante requestAnimationFrame
  // para que los demás usuarios conectados al WebSocket vean el desplazamiento en vivo.
  const dragRafRef = useRef<number | null>(null);
  const activeDragNodeRef = useRef<{ id: string; position: { x: number; y: number } } | null>(null);

  useEffect(() => {
    return () => {
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
      }
    };
  }, []);

  const onNodeDrag = useCallback(
    (_event: React.MouseEvent | React.TouchEvent, node: Node) => {
      activeDragNodeRef.current = {
        id: node.id,
        position: { x: Math.round(node.position.x), y: Math.round(node.position.y) },
      };

      if (dragRafRef.current === null) {
        dragRafRef.current = requestAnimationFrame(() => {
          dragRafRef.current = null;
          const current = activeDragNodeRef.current;
          if (current) {
            handleNodeDragStop(doc, diagram.id, current);
          }
        });
      }
    },
    [doc, diagram.id],
  );

  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent | React.TouchEvent, node: Node) => {
      if (dragRafRef.current !== null) {
        cancelAnimationFrame(dragRafRef.current);
        dragRafRef.current = null;
      }
      activeDragNodeRef.current = null;
      handleNodeDragStop(doc, diagram.id, node);
    },
    [doc, diagram.id],
  );

  // Estado local sincronizado para arrastre suave y reactivo en tiempo real (60/120 FPS).
  // La posición canónica proviene del Y.Doc, pero durante el arrastre onNodesChange actualiza
  // de inmediato la posición del nodo en pantalla para que acompañe al cursor sin saltos.
  const [displayNodes, setDisplayNodes] = useState(nodes);
  useEffect(() => {
    setDisplayNodes((prev) => {
      const draggingId = activeDragNodeRef.current?.id;
      if (!draggingId) return nodes;
      return nodes.map((n) => {
        if (n.id === draggingId) {
          const localMatch = prev.find((p) => p.id === draggingId);
          return localMatch ? { ...n, position: localMatch.position } : n;
        }
        return n;
      });
    });
  }, [nodes]);

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setDisplayNodes((nds) => applyNodeChanges(changes, nds) as typeof nds);
  }, []);

  const edges = useMemo<Edge[]>(
    () => [
      ...diagram.associations.map((assoc) => ({
        id: assoc.id,
        source: assoc.sourceClassId,
        target: assoc.targetClassId,
        type: 'association' as const,
        data: { association: assoc },
      })),
      // Unidad 11.3 — aristas de generalización: origen = subClase, destino = superClase
      // para que el marcador de triángulo hueco se renderice en el extremo de la superclase.
      ...diagram.generalizations.map((gen) => ({
        id: gen.id,
        source: gen.subClassId,
        target: gen.superClassId,
        type: 'generalization' as const,
        data: { generalization: gen },
      })),
      // Unidad 12.3 — aristas de realización: origen = clase cliente, destino = interfaz
      // proveedora, para que la línea discontinua + triángulo hueco se renderice en el extremo de la interfaz.
      ...(diagram.realizations ?? []).map((real) => ({
        id: real.id,
        source: real.clientClassId,
        target: real.supplierInterfaceId,
        type: 'realization' as const,
        data: { realization: real },
      })),
      // Unidad 12.3 (12b) — aristas de dependencia: origen = clase cliente, destino =
      // proveedor, para que la línea discontinua + flecha abierta se renderice en el extremo del proveedor.
      ...(diagram.dependencies ?? []).map((dep) => ({
        id: dep.id,
        source: dep.clientClassId,
        target: dep.supplierClassId,
        type: 'dependency' as const,
        data: { dependency: dep },
      })),
      // Unidad 13.2 — una arista simple por extremo miembro n-ario: diamante → clase,
      // etiquetada con la multiplicidad de dicho extremo (y rol cuando esté presente).
      ...(diagram.naryAssociations ?? []).flatMap((nary) =>
        nary.memberEnds.map((end) => ({
          id: `${nary.id}:${end.classId}`,
          source: nary.id,
          target: end.classId,
          type: 'naryEnd' as const,
          data: { end, naryAssociationId: nary.id },
        })),
      ),
    ],
    [diagram],
  );

  // unidad 13c — la arista seleccionada resuelta a partir de la proyección en vivo. Cuando la
  // arista desaparece (eliminada desde cualquier lugar), esto pasa a null y el editor
  // se cierra automáticamente — sin panel obsoleto.
  const selectedEdgeData = useMemo(
    () => {
      if (selectedEdge === null) {
        return null;
      }
      switch (selectedEdge.type) {
        case 'association': {
          const assoc = diagram.associations.find((a) => a.id === selectedEdge.id);
          return assoc ? { type: 'association' as const, edge: assoc } : null;
        }
        case 'generalization': {
          const gen = diagram.generalizations.find((g) => g.id === selectedEdge.id);
          return gen ? { type: 'generalization' as const, edge: gen } : null;
        }
        case 'realization': {
          const real = (diagram.realizations ?? []).find((r) => r.id === selectedEdge.id);
          return real ? { type: 'realization' as const, edge: real } : null;
        }
        case 'dependency': {
          const dep = (diagram.dependencies ?? []).find((d) => d.id === selectedEdge.id);
          return dep ? { type: 'dependency' as const, edge: dep } : null;
        }
      }
    },
    [diagram, selectedEdge],
  );

  // unidad 13d corrección A — el n-ario seleccionado resuelto a partir de la proyección en vivo.
  // Cuando la asociación desaparece (eliminada desde cualquier lugar), esto pasa a
  // null y el editor de diamante se cierra automáticamente — sin panel obsoleto.
  const selectedNary = useMemo(
    () => (diagram.naryAssociations ?? []).find((n) => n.id === selectedNaryId) ?? null,
    [diagram, selectedNaryId],
  );

  /**
   * unidad 13d corrección A — confirma el campo Name del editor de diamante (vacío borra,
   * reflejando la semántica de etiquetas de aristas).
   */
  const commitNaryName = (value: string): void => {
    if (selectedNary === null) {
      return;
    }
    handleUpdateNaryAssociation(doc, diagram.id, selectedNary.id, { name: value.trim() });
  };

  /**
   * unidad 13d corrección A — confirma la multiplicidad de un extremo miembro: reconstruye el arreglo
   * completo memberEnds (semántica de reemplazo del delta update central) cambiando únicamente
   * dicho extremo; los roles y los otros extremos se conservan. La entrada inválida está
   * protegida dentro de handleUpdateNaryAssociation (no se emite delta).
   */
  const commitNaryEndMultiplicity = (classId: string, value: string): void => {
    if (selectedNary === null) {
      return;
    }
    const memberEnds: NaryMemberEndInput[] = selectedNary.memberEnds.map((end) => ({
      classId: end.classId,
      multiplicity: end.classId === classId ? value.trim() : end.multiplicity,
      ...(end.role !== undefined ? { role: end.role } : {}),
    }));
    handleUpdateNaryAssociation(doc, diagram.id, selectedNary.id, { memberEnds });
  };

  // Unit 11.4 — lista de generalización para la clase seleccionada (ambos roles).
  const selectedClass = useMemo(
    () => diagram.classes.find((cls) => cls.id === selectedClassId) ?? null,
    [diagram, selectedClassId],
  );
  const classNameById = (id: string): string =>
    diagram.classes.find((cls) => cls.id === id)?.name ?? '?';
  const selectedClassGeneralizations = useMemo(
    () =>
      selectedClass === null
        ? []
        : diagram.generalizations.filter(
            (gen) => gen.subClassId === selectedClass.id || gen.superClassId === selectedClass.id,
          ),
    [diagram, selectedClass],
  );

  // Unit 12.4 — lista de realización para la clase seleccionada (ambos roles).
  const selectedClassRealizations = useMemo(
    () =>
      selectedClass === null
        ? []
        : (diagram.realizations ?? []).filter(
            (real) => real.clientClassId === selectedClass.id || real.supplierInterfaceId === selectedClass.id,
          ),
    [diagram, selectedClass],
  );

  // Unit 12.4 (12b) — lista de dependencias para la clase seleccionada (ambos roles).
  const selectedClassDependencies = useMemo(
    () =>
      selectedClass === null
        ? []
        : (diagram.dependencies ?? []).filter(
            (dep) => dep.clientClassId === selectedClass.id || dep.supplierClassId === selectedClass.id,
          ),
    [diagram, selectedClass],
  );

  /**
   * unidad 13b/13e.7 — el elemento n-ario de la paleta conmuta el modo de selección (el antiguo
   * gemelo de la barra de herramientas desapareció). Ingresar a él desarma cualquier herramienta
   * de arista armada (los modos son exclusivos).
   */
  const toggleNaryMode = (): void => {
    setNaryMode((prev) => !prev);
    setNarySelection([]);
    setNaryEnds({});
    setNaryName('');
    setEdgeTool(null);
    setEdgeMessage(null);
  };

  /** unidad 13b — armar/desarmar una herramienta de arista; armar sale del modo de selección n-ario. */
  const changeEdgeTool = (tool: PaletteEdgeTool | null): void => {
    setEdgeTool(tool);
    setEdgeMessage(null);
    if (tool !== null) {
      setNaryMode(false);
      setNarySelection([]);
      setNaryEnds({});
      setNaryName('');
    }
  };

  /**
   * unidad 13c — confirma el campo Label del editor unificado para cualquiera que sea el tipo
   * de arista seleccionado. Las asociaciones conservan la ruta de actualización de metadatos (vacío borra);
   * los tres tipos de etiqueta emiten el delta `update` de nombre de core (vacío borra).
   */
  const commitEdgeLabel = (value: string): void => {
    if (selectedEdgeData === null) {
      return;
    }
    const trimmed = value.trim();
    switch (selectedEdgeData.type) {
      case 'association':
        handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { name: trimmed || undefined });
        break;
      case 'generalization':
        handleUpdateGeneralizationLabel(doc, diagram.id, selectedEdgeData.edge.id, trimmed);
        break;
      case 'realization':
        handleUpdateRealizationLabel(doc, diagram.id, selectedEdgeData.edge.id, trimmed);
        break;
      case 'dependency':
        handleUpdateDependencyLabel(doc, diagram.id, selectedEdgeData.edge.id, trimmed);
        break;
    }
  };

  /** unidad 13c — elimina la arista seleccionada vía el delta delete de su tipo y cierra. */
  const deleteSelectedEdge = (): void => {
    if (selectedEdgeData === null) {
      return;
    }
    switch (selectedEdgeData.type) {
      case 'association':
        handleDeleteAssociation(doc, diagram.id, selectedEdgeData.edge.id);
        break;
      case 'generalization':
        handleDeleteGeneralization(doc, diagram.id, selectedEdgeData.edge.id);
        break;
      case 'realization':
        handleDeleteRealization(doc, diagram.id, selectedEdgeData.edge.id);
        break;
      case 'dependency':
        handleDeleteDependency(doc, diagram.id, selectedEdgeData.edge.id);
        break;
    }
    setSelectedEdge(null);
  };

  // Comodidad estilo EA: atajos de teclado globales para Escape, Delete y flechas de dirección.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setEdgeTool(null);
        setEdgeMessage(null);
        setSelectedClassId(null);
        setSelectedEdge(null);
        setSelectedNaryId(null);
        return;
      }

      // Evitar interceptar teclas mientras se edita texto en inputs, textareas o selects
      const target = event.target as HTMLElement | null;
      const isInput =
        target !== null &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);
      if (isInput) {
        return;
      }

      // Teclas de eliminación: Delete o Backspace para el elemento seleccionado
      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (selectedClassId !== null) {
          event.preventDefault();
          handleDeleteClass(selectedClassId);
          setSelectedClassId(null);
          return;
        }
        if (selectedEdge !== null) {
          event.preventDefault();
          deleteSelectedEdge();
          return;
        }
        if (selectedNaryId !== null) {
          event.preventDefault();
          handleDeleteNaryAssociation(doc, diagram.id, selectedNaryId);
          setSelectedNaryId(null);
          return;
        }
      }

      // Flechas de dirección: desplazar la clase seleccionada en pasos de 20px (alineación a cuadrícula)
      if (selectedClassId !== null && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
        const cls = diagram.classes.find((c) => c.id === selectedClassId);
        if (cls) {
          event.preventDefault();
          let dx = 0;
          let dy = 0;
          if (event.key === 'ArrowUp') dy = -20;
          if (event.key === 'ArrowDown') dy = 20;
          if (event.key === 'ArrowLeft') dx = -20;
          if (event.key === 'ArrowRight') dx = 20;

          handleNodeDragStop(doc, diagram.id, {
            id: cls.id,
            position: {
              x: Math.round((cls.position.x + dx) / 20) * 20,
              y: Math.round((cls.position.y + dy) / 20) * 20,
            },
          });
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [doc, diagram, selectedClassId, selectedEdge, selectedNaryId]);

  return (
    <div className="diagram-canvas" style={{ width: '100%', height: '100%' }}>
      {/* unidad 13b — riel de creación izquierdo: arrastrar nodos, armar herramientas de aristas, n-ario.
          unidad 13e.11 — el lienzo posee el estado de colapso (alternador de encabezado). */}
      <Palette
        activeEdgeTool={edgeTool}
        naryMode={naryMode}
        onEdgeToolChange={changeEdgeTool}
        onNaryModeToggle={toggleNaryMode}
        collapsed={paletteCollapsed}
        onToggleCollapsed={() => setPaletteCollapsed((prev) => !prev)}
        onNodeClick={handlePaletteQuickAdd}
      />
      {/* unidad 13e.7 — la barra de herramientas heredada `.diagram-canvas__toolbar` (Add class /
          Add interface / Link classes / N-ary association / Directed) fue
          ELIMINADA: los elementos de la paleta + arrastrar para conectar + Quick Linker la
          reemplazan por completo (solicitud del usuario: "quitar los botones antiguos"). */}
      {/* unidad 13b — ayudas visuales para la herramienta de arista armada + retroalimentación de protección. */}
      {edgeTool !== null && (
        <div className="diagram-canvas__hint" data-testid="edge-tool-hint" role="status">
          {tr('canvas.edgeToolHint', { tool: tr(CONNECTOR_TOOL_KEYS[edgeTool]) })}
        </div>
      )}
      {edgeMessage !== null && (
        <div className="diagram-canvas__palette-message" role="alert" data-testid="palette-validation">
          {edgeMessage}
        </div>
      )}
      {naryMode && narySelection.length > 0 && (
        <div className="diagram-canvas__nary" data-testid="nary-panel">
          <span className="diagram-canvas__nary-title">
            {tr('nary.panelTitle', { n: narySelection.length })}
          </span>
          {narySelection.map((classId) => {
            const cls = diagram.classes.find((candidate) => candidate.id === classId);
            if (cls === undefined) return null;
            return (
              <label key={classId} className="diagram-canvas__nary-end">
                {cls.name}
                <input
                  aria-label={tr('nary.multiplicityFor', { name: cls.name })}
                  value={naryEnds[classId] ?? '1'}
                  onChange={(event) =>
                    setNaryEnds((prev) => ({ ...prev, [classId]: event.target.value }))
                  }
                />
              </label>
            );
          })}
          <label>
            {tr('nary.name')}
            <input
              aria-label={tr('nary.nameAria')}
              placeholder={tr('nary.optional')}
              value={naryName}
              onChange={(event) => setNaryName(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="diagram-canvas__create-nary"
            aria-label={tr('nary.createAria')}
            disabled={narySelection.length < 3}
            onClick={handleCreateNaryFromPanel}
          >
            {tr('nary.create')}
          </button>
        </div>
      )}
      {/* unidad 13c — UN solo editor de arista unificado para cada tipo de arista: etiqueta +
          eliminar para todas, multiplicidades/roles solo para asociaciones. El
          tipo de agregación se elige en el momento de creación vía la paleta
          (herramientas Agregación/Composición), por lo que aquí no hay menús desplegables. */}
      {selectedEdgeData && (
        <div className="diagram-canvas__edge-editor" data-testid="edge-editor" key={selectedEdgeData.edge.id}>
          <span className="diagram-canvas__edge-editor-title">
            {tr(EDGE_TYPE_KEYS[selectedEdgeData.type])}
          </span>
          <label>
            {selectedEdgeData.type === 'association' ? tr('editor.associationName') : tr('editor.label')}
            <input
              aria-label={
                selectedEdgeData.type === 'association'
                  ? tr('editor.associationName')
                  : tr('editor.labelAria', { type: tr(EDGE_TYPE_KEYS[selectedEdgeData.type]) })
              }
              defaultValue={selectedEdgeData.edge.name ?? ''}
              onBlur={(event) => commitEdgeLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitEdgeLabel((event.target as HTMLInputElement).value);
                }
              }}
            />
          </label>
          {selectedEdgeData.type === 'association' && (
            <>
              <label>
                {tr('editor.sourceRole')}
                <input
                  aria-label={tr('editor.sourceRole')}
                  defaultValue={selectedEdgeData.edge.sourceRole ?? ''}
                  onBlur={(event) =>
                    handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { sourceRole: event.target.value.trim() || undefined })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { sourceRole: (event.target as HTMLInputElement).value.trim() || undefined });
                    }
                  }}
                />
              </label>
              <label>
                {tr('editor.targetRole')}
                <input
                  aria-label={tr('editor.targetRole')}
                  defaultValue={selectedEdgeData.edge.targetRole ?? ''}
                  onBlur={(event) =>
                    handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { targetRole: event.target.value.trim() || undefined })
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, { targetRole: (event.target as HTMLInputElement).value.trim() || undefined });
                    }
                  }}
                />
              </label>
              <label>
                {tr('editor.sourceMultiplicity')}
                <input
                  aria-label={tr('editor.sourceMultiplicity')}
                  defaultValue={selectedEdgeData.edge.sourceMultiplicity ?? ''}
                  onBlur={(event) =>
                    handleUpdateMultiplicity(doc, diagram.id, selectedEdgeData.edge.id, 'source', event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleUpdateMultiplicity(doc, diagram.id, selectedEdgeData.edge.id, 'source', (event.target as HTMLInputElement).value);
                    }
                  }}
                />
              </label>
              <label>
                {tr('editor.targetMultiplicity')}
                <input
                  aria-label={tr('editor.targetMultiplicity')}
                  defaultValue={selectedEdgeData.edge.targetMultiplicity}
                  onBlur={(event) =>
                    handleUpdateMultiplicity(doc, diagram.id, selectedEdgeData.edge.id, 'target', event.target.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      handleUpdateMultiplicity(doc, diagram.id, selectedEdgeData.edge.id, 'target', (event.target as HTMLInputElement).value);
                    }
                  }}
                />
              </label>
              {/* Control de inversión del extremo del diamante — solo para asociaciones de agregación/composición */}
              {selectedEdgeData.edge.aggregation !== 'none' && selectedEdgeData.edge.aggregationEnd !== undefined && (
                <div className="diagram-canvas__flip-diamond">
                  <span>
                    {tr('editor.diamondEnd', {
                      end: selectedEdgeData.edge.aggregationEnd === 'source' ? tr('editor.endSource') : tr('editor.endTarget'),
                    })}
                  </span>
                  <button
                    type="button"
                    aria-label={tr('editor.flipDiamondEndAria', {
                      end: selectedEdgeData.edge.aggregationEnd === 'source' ? tr('editor.endTarget') : tr('editor.endSource'),
                    })}
                    onClick={() =>
                      handleUpdateAssociationMeta(doc, diagram.id, selectedEdgeData.edge.id, {
                        aggregationEnd: selectedEdgeData.edge.aggregationEnd === 'source' ? 'target' : 'source',
                      })
                    }
                  >
                    {tr('editor.flipDiamondEnd')}
                  </button>
                </div>
              )}
            </>
          )}
          <button
            type="button"
            className="diagram-canvas__delete-edge"
            aria-label={tr('editor.deleteAria', { type: selectedEdgeData.type, id: selectedEdgeData.edge.id })}
            onClick={deleteSelectedEdge}
          >
            {tr('editor.delete', { type: selectedEdgeData.type })}
          </button>
          <button
            type="button"
            className="diagram-canvas__close-edge-editor"
            aria-label={tr('editor.closeAria')}
            onClick={() => setSelectedEdge(null)}
          >
            {tr('editor.close')}
          </button>
        </div>
      )}
      {/* unidad 13d corrección A — el editor propio del diamante n-ario (mismo patrón que el
          editor de aristas unificado): nombre editable, un campo de multiplicidad por
          extremo miembro (etiquetado por el nombre de la clase), y Eliminar. Cada confirmación emite
          el delta `update` de naryAssociation de core. */}
      {selectedNary && (
        <div className="diagram-canvas__edge-editor" data-testid="nary-editor" key={selectedNary.id}>
          <span className="diagram-canvas__edge-editor-title">
            {tr('naryEditor.title')}
          </span>
          <label>
            {tr('nary.name')}
            <input
              aria-label={tr('naryEditor.nameAria')}
              defaultValue={selectedNary.name ?? ''}
              onBlur={(event) => commitNaryName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  commitNaryName((event.target as HTMLInputElement).value);
                }
              }}
            />
          </label>
          {selectedNary.memberEnds.map((end) => {
            const cls = diagram.classes.find((candidate) => candidate.id === end.classId);
            return (
              <label key={end.classId} className="diagram-canvas__nary-end">
                {cls?.name ?? '?'}
                <input
                  aria-label={tr('naryEditor.endMultiplicityAria', { name: cls?.name ?? end.classId })}
                  defaultValue={end.multiplicity}
                  onBlur={(event) => commitNaryEndMultiplicity(end.classId, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      commitNaryEndMultiplicity(end.classId, (event.target as HTMLInputElement).value);
                    }
                  }}
                />
              </label>
            );
          })}
          <button
            type="button"
            className="diagram-canvas__delete-edge"
            aria-label={tr('naryEditor.deleteAria', { id: selectedNary.id })}
            onClick={() => {
              handleDeleteNaryAssociation(doc, diagram.id, selectedNary.id);
              // La resolución de selectedNary basada en proyecciones cierra el
              // panel; limpiar el id también cubre el caso en el mismo tick.
              setSelectedNaryId(null);
            }}
          >
            {tr('naryEditor.delete')}
          </button>
          <button
            type="button"
            className="diagram-canvas__close-edge-editor"
            aria-label={tr('naryEditor.closeAria')}
            onClick={() => setSelectedNaryId(null)}
          >
            {tr('editor.close')}
          </button>
        </div>
      )}
      {selectedClass && (
        <div className="diagram-canvas__generalizations" data-testid="generalization-panel">
          <span className="diagram-canvas__generalizations-title">
            {tr('panel.generalizationsFor', { name: selectedClass.name })}
          </span>
          {selectedClassGeneralizations.length === 0 && (
            <span className="diagram-canvas__generalizations-empty">{tr('panel.none')}</span>
          )}
          {selectedClassGeneralizations.map((gen) => (
            <div key={gen.id} className="diagram-canvas__generalization-row">
              <span>
                {gen.subClassId === selectedClass.id
                  ? tr('panel.inheritsFrom', { name: classNameById(gen.superClassId) })
                  : tr('panel.inheritedBy', { name: classNameById(gen.subClassId) })}
              </span>
              <button
                type="button"
                className="diagram-canvas__delete-generalization"
                aria-label={tr('panel.removeInheritanceAria', { id: gen.id })}
                onClick={() => handleDeleteGeneralization(doc, diagram.id, gen.id)}
              >
                {tr('panel.removeInheritance')}
              </button>
            </div>
          ))}
        </div>
      )}
      {selectedClass && (
        <div className="diagram-canvas__realizations" data-testid="realization-panel">
          <span className="diagram-canvas__realizations-title">
            {tr('panel.realizationsFor', { name: selectedClass.name })}
          </span>
          {selectedClassRealizations.length === 0 && (
            <span className="diagram-canvas__realizations-empty">{tr('panel.none')}</span>
          )}
          {selectedClassRealizations.map((real) => (
            <div key={real.id} className="diagram-canvas__realization-row">
              <span>
                {real.clientClassId === selectedClass.id
                  ? tr('panel.realizes', { name: classNameById(real.supplierInterfaceId) })
                  : tr('panel.realizedBy', { name: classNameById(real.clientClassId) })}
              </span>
              <button
                type="button"
                className="diagram-canvas__delete-realization"
                aria-label={tr('panel.removeRealizationAria', { id: real.id })}
                onClick={() => handleDeleteRealization(doc, diagram.id, real.id)}
              >
                {tr('panel.removeRealization')}
              </button>
            </div>
          ))}
        </div>
      )}
      {selectedClass && (
        <div className="diagram-canvas__dependencies" data-testid="dependency-panel">
          <span className="diagram-canvas__dependencies-title">
            {tr('panel.dependenciesFor', { name: selectedClass.name })}
          </span>
          {selectedClassDependencies.length === 0 && (
            <span className="diagram-canvas__dependencies-empty">{tr('panel.none')}</span>
          )}
          {selectedClassDependencies.map((dep) => (
            <div key={dep.id} className="diagram-canvas__dependency-row">
              <span>
                {dep.clientClassId === selectedClass.id
                  ? tr('panel.dependsOn', { name: classNameById(dep.supplierClassId) })
                  : tr('panel.dependencyFrom', { name: classNameById(dep.clientClassId) })}
              </span>
              <button
                type="button"
                className="diagram-canvas__delete-dependency"
                aria-label={tr('panel.removeDependencyAria', { id: dep.id })}
                onClick={() => handleDeleteDependency(doc, diagram.id, dep.id)}
              >
                {tr('panel.removeDependency')}
              </button>
            </div>
          ))}
        </div>
      )}
      <EdgeCrossingProvider>
        <ReactFlow
          nodes={displayNodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          // unidad 13b — las conexiones solo se pueden iniciar mientras una herramienta de
          // arista esté armada; el modo suelto permite iniciar el arrastre desde cualquier conector (el delta
          // se enfoca en la dirección del nodo, no en la identidad del conector).
          nodesConnectable={edgeTool !== null}
          connectionMode="loose"
          // unidad 13c — radio de ajuste indulgente alrededor de los conectores; combinado con las
          // superposiciones de conexión en todo el nodo permite arrastrar para conectar desde el cuerpo.
          connectionRadius={40}
          onConnect={onConnect}
          onEdgesChange={() => {}}
          onDrop={onDrop}
          onDragOver={onDragOver}
          onInit={(instance) => {
            rfRef.current = instance;
          }}
          onNodesChange={onNodesChange}
        onNodeClick={(_event, node) => handleNodeClick(node)}
        // unidad 13c — hacer clic en cualquier tipo de arista de editor abre el editor
        // ÚNICO unificado; las aristas de miembros n-arios conservan su propio flujo de diamante.
        onEdgeClick={(_event, edge) => {
          if (isEditorEdgeType(edge.type)) {
            setSelectedEdge({ id: edge.id, type: edge.type });
            // Los editores son exclusivos: abrir el editor de aristas cierra el
            // editor de diamante n-ario (unidad 13d corrección A).
            setSelectedNaryId(null);
          }
        }}
        // unidad 13d corrección D — hacer clic en el lienzo vacío deselecciona: limpia la
        // clase seleccionada, cierra los editores de arista/n-ario, y desarma cualquier
        // herramienta de arista armada (el equivalente con clic a Escape).
        onPaneClick={() => {
          setSelectedClassId(null);
          setSelectedEdge(null);
          setSelectedNaryId(null);
          setEdgeTool(null);
          setEdgeMessage(null);
        }}
        onNodeDrag={onNodeDrag}
        onNodeDragStop={onNodeDragStop}
        snapToGrid={true}
        snapGrid={[20, 20]}
        fitView
      >
        {/* unidad 13e — lienzo estilo EA: sutil cuadrícula de puntos nítidos detrás de los elementos. */}
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="#94a3b8" />
        {/* Límite visual del lienzo: hoja de diagrama con bordes definidos y sombreado exterior */}
        <ViewportPortal>
          <div
            className="diagram-canvas-boundary"
            data-testid="diagram-canvas-boundary"
            style={{
              transform: `translate(${canvasBoundary.left}px, ${canvasBoundary.top}px)`,
              width: `${canvasBoundary.width}px`,
              height: `${canvasBoundary.height}px`,
            }}
          >
            <div className="diagram-canvas-boundary__header">
              <span className="diagram-canvas-boundary__title">
                {diagram.name || tr('canvas.pageBoundary')}
              </span>
              <span className="diagram-canvas-boundary__dimensions">
                {canvasBoundary.width} × {canvasBoundary.height} px
              </span>
            </div>
          </div>
        </ViewportPortal>
      </ReactFlow>
      </EdgeCrossingProvider>
      {/* unidad 13d — banda elástica de Quick Linker: una delgada línea discontinua desde la
          flecha de la esquina hasta el cursor en vivo mientras corre el arrastre de enlace rápido. */}
      {quickLinkDrag !== null && (
        <svg className="quicklinker-rubberband" data-testid="quicklinker-rubberband" aria-hidden="true">
          <line
            x1={quickLinkDrag.start.x}
            y1={quickLinkDrag.start.y}
            x2={quickLinkDrag.cursor.x}
            y2={quickLinkDrag.cursor.y}
          />
        </svg>
      )}
      {/* unidad 13d — el menú filtrado por metamodelo: opciones de conector sobre un
          elemento existente, tipos de elementos creables sobre lienzo vacío.
          Escape / clic afuera cierra SIN crear nada. */}
      {quickLinkMenu !== null &&
        (quickLinkMenu.mode === 'connector' ? (
          <QuickLinkerMenu
            position={quickLinkMenu.anchor}
            items={validConnectorsFor(quickLinkMenu.sourceKind, quickLinkMenu.targetKind, quickLinkMenu.sourceId === quickLinkMenu.targetId).map(
              (connector) => ({ id: connector, label: tr(CONNECTOR_TOOL_KEYS[connector]) }),
            )}
            onSelect={(id) => pickQuickConnector(id as QuickConnectorType)}
            onClose={() => setQuickLinkMenu(null)}
          />
        ) : (
          <QuickLinkerMenu
            position={quickLinkMenu.anchor}
            items={elementMenuOptions().map((kind) => ({ id: kind, label: tr(ELEMENT_TOOL_KEYS[kind]) }))}
            onSelect={pickQuickElement}
            onClose={() => setQuickLinkMenu(null)}
          />
        ))}
    </div>
  );
}