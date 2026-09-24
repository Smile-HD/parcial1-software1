/**
 * Nodo de clase UML renderizado dentro de un lienzo de React Flow.
 * Los handles se colocan a la izquierda (target) y a la derecha (source) para aristas de asociación.
 *
 * editor:R2 — renombrado en línea: doble clic en el título para editar; confirmar con
 * blur/Enter (mediante el callback onRename, que emite un delta de renombrado).
 *
 * unidad 13e — caja clasificadora estilo EA: tres compartimentos delimitados por 1px (nombre /
 * atributos / operaciones, los vacíos se mantienen como franjas delgadas), el estereotipo
 * sobre el nombre en negrita centrado y la clásica pestaña de esquina doblada en la
 * esquina superior derecha. `uml-class--selected` maneja el borde de selección azul de EA.
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { Attribute, ClassKind, Method, Parameter, Visibility } from '@app/core';

import { useT } from '../i18n';

/** Adornos UML transportados por operaciones de agregar/editar miembros (unidad 9). */
export interface MemberAdornments {
  visibility?: Visibility;
  isStatic?: boolean;
  isDerived?: boolean;
  multiplicity?: string;
}

export type ClassNodeData = Record<string, unknown> & {
  name: string;
  attributes: readonly Attribute[];
  methods: readonly Method[];
  /** Unidad 12.1: tipo de clasificador ('class' | 'interface') y marca abstracta. */
  kind: ClassKind;
  isAbstract: boolean;
  /** Otras clases en el diagrama — candidatas para "hacer subclase de" (unidad 11.4). */
  otherClasses: readonly { id: string; name: string }[];
  /** Interfaces en el diagrama — candidatas para "realizar" (unidad 12.4). */
  otherInterfaces: readonly { id: string; name: string }[];
  onRename: (newName: string) => void;
  onDelete: () => void;
  onAddAttribute: (name: string, type: string, adornments?: MemberAdornments) => void;
  onEditAttribute: (memberId: string, name: string, type: string, adornments?: MemberAdornments) => void;
  onRemoveAttribute: (memberId: string) => void;
  onAddMethod: (name: string, returnType: string, parameters: Parameter[], adornments?: MemberAdornments) => void;
  onEditMethod: (memberId: string, name: string, returnType: string, parameters: Parameter[], adornments?: MemberAdornments) => void;
  onRemoveMethod: (memberId: string) => void;
  /** Unidad 11.4: emitir una creación de generalización con esta clase como subClass. */
  onMakeSubclass: (superClassId: string) => void;
  /** Unidad 12.4: alternar la marca abstracta mediante un delta de actualización de clase. */
  onToggleAbstract: (isAbstract: boolean) => void;
  /** Unidad 12.4: emitir una creación de realización con esta clase como cliente. */
  onRealize: (supplierInterfaceId: string) => void;
  /** Unidad 12.4 (12b): emitir una creación de dependencia con esta clase como cliente. */
  onDependOn: (supplierClassId: string) => void;
  /** Unidad 11.4: seleccionar esta clase para mostrar su lista de generalizaciones en el panel. */
  onSelect: () => void;
  /**
   * Unidad 13c — arrastrar para conectar en todo el nodo: cuando una herramienta de borde está
   * armada, el lienzo renderiza un handle origen transparente que cubre todo el nodo para que una
   * conexión pueda COMENZAR en cualquier parte del cuerpo, no solo en los pequeños puntos de conexión.
   * Cuando no está armada la superposición no existe, por lo que el arrastre del nodo queda intacto.
   */
  connectArmed?: boolean;
  /**
   * Unidad 13d — Quick Linker estilo EA: true cuando este nodo es el elemento
   * seleccionado del lienzo. La flecha de esquina se renderiza ÚNICAMENTE en ese caso (oculta en caso contrario).
   */
  selected?: boolean;
  /**
   * Unidad 13d — pointer-down en la flecha de Quick Linker inicia el arrastre de
   * enlace rápido; el lienzo sigue el cursor y resuelve la soltada (menú de conector
   * sobre un elemento, menú de elemento sobre el lienzo vacío).
   */
  onQuickLinkStart?: (clientX: number, clientY: number) => void;
};

export type ClassFlowNode = import('@xyflow/react').Node<ClassNodeData, 'class'>;

/**
 * editor:R3 — entradas de parámetros separadas por coma con la forma `nombre: tipo`;
 * la ausencia de tipo recurre a `any`. Las entradas en blanco se descartan para que el
 * delta emitido siempre cumpla con MemberDeltaSchema (nombre/tipo de parámetro mín. 1).
 */
function parseParameters(input: string): Parameter[] {
  return input
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const colon = entry.indexOf(':');
      const name = (colon === -1 ? entry : entry.slice(0, colon)).trim();
      const type = (colon === -1 ? '' : entry.slice(colon + 1)).trim();
      return { name, type: type || 'any' };
    })
    .filter((param) => param.name.length > 0);
}

/**
 * Renderizado de miembros UML 2.5.1 (unidad 9.3): prefijo de visibilidad, `/` para derivados,
 * `[mult]` tras el tipo, nombres estáticos subrayados mediante la clase CSS.
 */
export function renderAttribute(attr: Attribute): string {
  const vis = attr.visibility ?? '+';
  const name = (attr.isDerived ? '/' : '') + attr.name;
  const mult = attr.multiplicity !== undefined ? ` [${attr.multiplicity}]` : '';
  return `${vis}${name}: ${attr.type}${mult}`;
}

export function renderMethod(method: Method): string {
  const vis = method.visibility ?? '+';
  const params = method.parameters.map((p) => p.type).join(', ');
  return `${vis}${method.name}(${params}): ${method.returnType}`;
}

export function ClassNode({ data }: NodeProps<ClassFlowNode>) {
  // unidad 13e.10 — cada cadena del menú contextual/edición de miembros pasa por el
  // diccionario i18n; useT() vuelve a renderizar este nodo en vivo al alternar el idioma.
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.name);
  const doneRef = useRef(false);

  // Unidad 11.4 — menú contextual de clase ("hacer subclase de").
  const [menuOpen, setMenuOpen] = useState(false);

  const [attrName, setAttrName] = useState('');
  const [attrType, setAttrType] = useState('');
  const [attrVisibility, setAttrVisibility] = useState<Visibility>('+' as Visibility);
  const [attrStatic, setAttrStatic] = useState(false);
  const [attrDerived, setAttrDerived] = useState(false);
  const [attrMultiplicity, setAttrMultiplicity] = useState('');
  const [attrError, setAttrError] = useState<string | null>(null);

  const [methodName, setMethodName] = useState('');
  const [methodReturnType, setMethodReturnType] = useState('');
  const [methodParams, setMethodParams] = useState('');
  const [methodVisibility, setMethodVisibility] = useState<Visibility>('+' as Visibility);
  const [methodStatic, setMethodStatic] = useState(false);
  const [methodError, setMethodError] = useState<string | null>(null);

  // editor:R3 — estado de edición de miembro in situ (un miembro editado a la vez).
  const [editingMember, setEditingMember] = useState<
    { kind: 'attribute' | 'method'; id: string } | null
  >(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('');
  const [editParams, setEditParams] = useState('');
  const [editVisibility, setEditVisibility] = useState<Visibility>('+' as Visibility);
  const [editStatic, setEditStatic] = useState(false);
  const [editDerived, setEditDerived] = useState(false);
  const [editMultiplicity, setEditMultiplicity] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const startEditing = (): void => {
    doneRef.current = false;
    setDraft(data.name);
    setEditing(true);
  };

  const commit = (): void => {
    if (doneRef.current) return;
    doneRef.current = true;
    const trimmed = draft.trim();
    if (trimmed.length > 0 && trimmed !== data.name) {
      data.onRename(trimmed);
    }
    setEditing(false);
  };

  const cancel = (): void => {
    doneRef.current = true;
    setEditing(false);
  };

  const submitAttribute = (): void => {
    const name = attrName.trim();
    const type = attrType.trim();
    // editor:R3 — los atributos con nombre en blanco se rechazan antes de emitir cualquier delta,
    // para que el modelo (Y.Doc) permanezca sin cambios.
    if (name.length === 0) {
      setAttrError(t('node.attrNameRequired'));
      return;
    }
    setAttrError(null);
    data.onAddAttribute(name, type, {
      visibility: attrVisibility,
      isStatic: attrStatic,
      isDerived: attrDerived,
      multiplicity: attrMultiplicity.trim() || undefined,
    });
    setAttrName('');
    setAttrType('');
    setAttrMultiplicity('');
    setAttrStatic(false);
    setAttrDerived(false);
  };

  const submitMethod = (): void => {
    const name = methodName.trim();
    // editor:R3 — los métodos con nombre en blanco se rechazan antes de emitir cualquier delta,
    // para que el modelo (Y.Doc) permanezca sin cambios. Un tipo de retorno en blanco recurre a
    // `void` para que el delta emitido siempre cumpla con MemberDeltaSchema (mín. 1).
    if (name.length === 0) {
      setMethodError(t('node.methodNameRequired'));
      return;
    }
    setMethodError(null);
    data.onAddMethod(name, methodReturnType.trim() || 'void', parseParameters(methodParams), {
      visibility: methodVisibility,
      isStatic: methodStatic,
    });
    setMethodName('');
    setMethodReturnType('');
    setMethodParams('');
    setMethodStatic(false);
  };

  const startEditAttribute = (attr: Attribute): void => {
    setEditingMember({ kind: 'attribute', id: attr.id });
    setEditName(attr.name);
    setEditType(attr.type);
    setEditParams('');
    setEditVisibility((attr.visibility ?? '+') as Visibility);
    setEditStatic(attr.isStatic ?? false);
    setEditDerived(attr.isDerived ?? false);
    setEditMultiplicity(attr.multiplicity ?? '');
    setEditError(null);
  };

  const startEditMethod = (method: Method): void => {
    setEditingMember({ kind: 'method', id: method.id });
    setEditName(method.name);
    setEditType(method.returnType);
    setEditParams(method.parameters.map((param) => `${param.name}: ${param.type}`).join(', '));
    setEditVisibility((method.visibility ?? '+') as Visibility);
    setEditStatic(method.isStatic ?? false);
    setEditDerived(false);
    setEditMultiplicity('');
    setEditError(null);
  };

  const cancelEdit = (): void => {
    setEditingMember(null);
    setEditError(null);
  };

  /**
   * editor:R3 — confirmar una edición de miembro in situ. Un nombre o tipo (de retorno) en blanco
   * se rechaza ANTES de emitir cualquier delta: `DeltaSchema.parse` de core
   * lanza error ante cadenas con min(1), por lo que esta guarda mantiene el modelo (Y.Doc)
   * sin cambios y muestra un mensaje de validación en su lugar.
   */
  const commitEdit = (): void => {
    if (editingMember === null) {
      return;
    }
    const name = editName.trim();
    const type = editType.trim();
    if (name.length === 0 || type.length === 0) {
      setEditError(t('node.nameTypeRequired'));
      return;
    }
    if (editingMember.kind === 'attribute') {
      data.onEditAttribute(editingMember.id, name, type, {
        visibility: editVisibility,
        isStatic: editStatic,
        isDerived: editDerived,
        multiplicity: editMultiplicity.trim() || undefined,
      });
    } else {
      data.onEditMethod(editingMember.id, name, type, parseParameters(editParams), {
        visibility: editVisibility,
        isStatic: editStatic,
      });
    }
    setEditingMember(null);
    setEditError(null);
  };

  const editKeyHandlers = {
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') commitEdit();
      if (e.key === 'Escape') cancelEdit();
    },
  };

  const isInterface = data.kind === 'interface';
  const isItalicName = isInterface || data.isAbstract;

  return (
    <div
      className={`uml-class${isInterface ? ' uml-class--interface' : ''}${data.selected === true ? ' uml-class--selected' : ''}`}
      onClick={data.onSelect}
      onContextMenu={(event) => {
        // editor:R Generalización (unidad 11.4) — clic derecho abre el
        // menú "hacer subclase de"; el menú del navegador se suprime.
        // La unidad 12.4 añade "realizar <interfaz>" y el alternador abstracto.
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {menuOpen && (
        <div className="uml-class__context-menu" role="menu" data-testid="class-context-menu">
          {data.otherClasses.length === 0 ? (
            <span className="uml-class__context-empty">{t('node.noOtherClasses')}</span>
          ) : (
            data.otherClasses.map((other) => (
              <button
                key={other.id}
                type="button"
                role="menuitem"
                aria-label={t('node.makeSubclassOf', { name: other.name })}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onMakeSubclass(other.id);
                  setMenuOpen(false);
                }}
              >
                {t('node.makeSubclassOf', { name: other.name })}
              </button>
            ))
          )}
          {/* Unidad 12.4 — realizar una interfaz (cliente = esta clase). Solo interfaces:
              el motor rechaza proveedores que no sean interfaz de todos modos. */}
          {data.otherInterfaces.map((iface) => (
            <button
              key={iface.id}
              type="button"
              role="menuitem"
              aria-label={t('node.realize', { name: iface.name })}
              onClick={(event) => {
                event.stopPropagation();
                data.onRealize(iface.id);
                setMenuOpen(false);
              }}
            >
              {t('node.realize', { name: iface.name })}
            </button>
          ))}
          {/* Unidad 12.4 (12b) — depende de (cliente = esta clase). El proveedor puede
              ser CUALQUIER otro clasificador (clase o interfaz) — a diferencia de realización.
              13e.10: reutiliza panel.dependsOn — redacción idéntica en bytes EN/ES. */}
          {data.otherClasses.map((other) => (
            <button
              key={`dep-${other.id}`}
              type="button"
              role="menuitem"
              aria-label={t('panel.dependsOn', { name: other.name })}
              onClick={(event) => {
                event.stopPropagation();
                data.onDependOn(other.id);
                setMenuOpen(false);
              }}
            >
              {t('panel.dependsOn', { name: other.name })}
            </button>
          ))}
          {/* Unidad 12.4 — alternador abstracto (las interfaces son implícitamente abstractas; ocultarlo allí). */}
          {!isInterface && (
            <button
              type="button"
              role="menuitem"
              aria-label={data.isAbstract ? t('node.unmarkAbstract') : t('node.markAbstract')}
              onClick={(event) => {
                event.stopPropagation();
                data.onToggleAbstract(!data.isAbstract);
                setMenuOpen(false);
              }}
            >
              {data.isAbstract ? t('node.unmarkAbstract') : t('node.markAbstract')}
            </button>
          )}
          <button
            type="button"
            aria-label={t('node.closeMenuAria')}
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
            }}
          >
            {t('node.close')}
          </button>
        </div>
      )}
      {/* unidad 13d — Quick Linker estilo EA: la flecha de esquina en la PARTE SUPERIOR DERECHA
          del elemento SELECCIONADO. Pointer-down inicia un arrastre de enlace rápido
          (menú de conector sobre un elemento destino, menú de elemento sobre lienzo
          vacío). Oculto cuando el nodo no está seleccionado; `nodrag` evita que React
          Flow convierta el gesto en un movimiento de nodo. */}
      {data.selected === true && (
        <button
          type="button"
          className="uml-class__quicklinker nodrag nopan"
          data-testid="quicklinker-arrow"
          aria-label="Quick Linker"
          title={t('node.quickLinkerTitle')}
          onPointerDown={(event) => {
            event.stopPropagation();
            event.preventDefault();
            data.onQuickLinkStart?.(event.clientX, event.clientY);
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path
              d="M 2 12 L 12 2 M 12 2 L 5.5 2 M 12 2 L 12 8.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
      {/* unidad 13e — firma de EA: la pestaña de esquina doblada en la parte superior derecha de
          cada caja clasificadora (el rasgo más reconocible de Sparx-EA). Puramente
          decorativo; la flecha de Quick Linker (13d) flota sobre ella cuando el
          nodo está seleccionado. */}
      <span className="uml-class__corner-tab" aria-hidden="true" />
      {/* unidad 13e — compartimento 1/3: el nombre (estereotipo arriba, negrita, centrado). */}
      <div className="uml-class__compartment uml-class__compartment--name">
        {editing ? (
          <input
            className="uml-class__title-input"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit();
              if (e.key === 'Escape') cancel();
            }}
          />
        ) : (
          <div className="uml-class__title" onDoubleClick={startEditing}>
            {/* Unidad 12.1 — encabezado de estereotipo UML para interfaces. */}
            {isInterface && <div className="uml-class__stereotype">«interface»</div>}
            <span className={`uml-class__name${isItalicName ? ' uml-class__name--italic' : ''}`}>{data.name}</span>
            <button
              type="button"
              className="uml-class__delete"
              aria-label={t('node.deleteAria', { name: data.name })}
              onClick={data.onDelete}
            >
              ×
            </button>
          </div>
        )}
      </div>

      {/* unidad 13e — compartimento 2/3: atributos. Siempre presente (los vacíos
          se renderizan como una franja delgada — el aspecto consistente de tres cajas de EA); la
          fila para agregar miembros reside dentro de él. */}
      <div className="uml-class__compartment uml-class__compartment--attributes">
        {data.attributes.length > 0 && (
          <div className="uml-class__section">
          {data.attributes.map((attr) =>
            editingMember?.kind === 'attribute' && editingMember.id === attr.id ? (
              <div key={attr.id} className="uml-class__member uml-class__edit">
                <input
                  className="uml-class__add-input"
                  aria-label={t('node.editAttrNameAria')}
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  {...editKeyHandlers}
                />
                <input
                  className="uml-class__add-input"
                  aria-label={t('node.editAttrTypeAria')}
                  value={editType}
                  onChange={(e) => setEditType(e.target.value)}
                  {...editKeyHandlers}
                />
                <button
                  type="button"
                  className="uml-class__add-button"
                  aria-label={t('node.confirmEditAria')}
                  onClick={commitEdit}
                >
                  ✓
                </button>
                <button
                  type="button"
                  className="uml-class__remove"
                  aria-label={t('node.cancelEditAria')}
                  onClick={cancelEdit}
                >
                  ×
                </button>
                {editError !== null && (
                  <p className="uml-class__validation" role="alert">
                    {editError}
                  </p>
                )}
              </div>
            ) : (
              <div key={attr.id} className="uml-class__member">
                <span
                  className={`uml-class__member-text${attr.isStatic ? ' uml-member--static' : ''}`}
                  data-testid={`attr-${attr.name}`}
                >
                  {renderAttribute(attr)}
                </span>
                <button
                  type="button"
                  className="uml-class__edit-button"
                  aria-label={t('node.editAttrAria', { name: attr.name })}
                  onClick={() => startEditAttribute(attr)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="uml-class__remove"
                  aria-label={t('node.removeAttrAria', { name: attr.name })}
                  onClick={() => data.onRemoveAttribute(attr.id)}
                >
                  ×
                </button>
              </div>
            ),
          )}
        </div>
      )}

      <div className="uml-class__section uml-class__add">
        <select
          className="uml-class__add-input"
          aria-label={t('node.attrVisibilityAria')}
          value={attrVisibility}
          onChange={(e) => setAttrVisibility(e.target.value as Visibility)}
        >
          <option value="+">+</option>
          <option value="-">-</option>
          <option value="#">#</option>
          <option value="~">~</option>
        </select>
        <input
          className="uml-class__add-input"
          aria-label={t('node.attrNameAria')}
          placeholder={t('node.phName')}
          value={attrName}
          onChange={(e) => setAttrName(e.target.value)}
        />
        <input
          className="uml-class__add-input"
          aria-label={t('node.attrTypeAria')}
          placeholder={t('node.phType')}
          value={attrType}
          onChange={(e) => setAttrType(e.target.value)}
        />
        <input
          className="uml-class__add-input"
          aria-label={t('node.attrMultiplicityAria')}
          placeholder="[0..*]"
          value={attrMultiplicity}
          onChange={(e) => setAttrMultiplicity(e.target.value)}
        />
        <label className="uml-class__toggle">
          <input type="checkbox" aria-label={t('node.attrStaticAria')} checked={attrStatic} onChange={(e) => setAttrStatic(e.target.checked)} />
          {t('node.static')}
        </label>
        <label className="uml-class__toggle">
          <input type="checkbox" aria-label={t('node.attrDerivedAria')} checked={attrDerived} onChange={(e) => setAttrDerived(e.target.checked)} />
          {t('node.derived')}
        </label>
        <button
          type="button"
          className="uml-class__add-button"
          aria-label={t('node.addAttrAria')}
          onClick={submitAttribute}
        >
          +
        </button>
        {attrError !== null && (
          <p className="uml-class__validation" role="alert">
            {attrError}
          </p>
        )}
      </div>
      </div>

      {/* unidad 13e — compartimento 3/3: operaciones (métodos). Siempre presente. */}
      <div className="uml-class__compartment uml-class__compartment--operations">
      {data.methods.length > 0 && (
        <div className="uml-class__section">
          {data.methods.map((method) => {
            if (editingMember?.kind === 'method' && editingMember.id === method.id) {
              return (
                <div key={method.id} className="uml-class__member uml-class__edit">
                  <input
                    className="uml-class__add-input"
                    aria-label={t('node.editMethodNameAria')}
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    {...editKeyHandlers}
                  />
                  <input
                    className="uml-class__add-input"
                    aria-label={t('node.editMethodReturnTypeAria')}
                    value={editType}
                    onChange={(e) => setEditType(e.target.value)}
                    {...editKeyHandlers}
                  />
                  <input
                    className="uml-class__add-input"
                    aria-label={t('node.editMethodParamsAria')}
                    placeholder={t('node.phParams')}
                    value={editParams}
                    onChange={(e) => setEditParams(e.target.value)}
                    {...editKeyHandlers}
                  />
                  <button
                    type="button"
                    className="uml-class__add-button"
                    aria-label={t('node.confirmEditAria')}
                    onClick={commitEdit}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className="uml-class__remove"
                    aria-label={t('node.cancelEditAria')}
                    onClick={cancelEdit}
                  >
                    ×
                  </button>
                  {editError !== null && (
                    <p className="uml-class__validation" role="alert">
                      {editError}
                    </p>
                  )}
                </div>
              );
            }
            const params = method.parameters.map((p) => p.type).join(', ');
            return (
              <div key={method.id} className="uml-class__member">
                <span
                  className={`uml-class__member-text${method.isStatic ? ' uml-member--static' : ''}`}
                  data-testid={`method-${method.name}`}
                >
                  {renderMethod(method)}
                </span>
                <button
                  type="button"
                  className="uml-class__edit-button"
                  aria-label={t('node.editMethodAria', { name: method.name })}
                  onClick={() => startEditMethod(method)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="uml-class__remove"
                  aria-label={t('node.removeMethodAria', { name: method.name })}
                  onClick={() => data.onRemoveMethod(method.id)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div className="uml-class__section uml-class__add">
        <select
          className="uml-class__add-input"
          aria-label={t('node.methodVisibilityAria')}
          value={methodVisibility}
          onChange={(e) => setMethodVisibility(e.target.value as Visibility)}
        >
          <option value="+">+</option>
          <option value="-">-</option>
          <option value="#">#</option>
          <option value="~">~</option>
        </select>
        <input
          className="uml-class__add-input"
          aria-label={t('node.methodNameAria')}
          placeholder={t('node.phName')}
          value={methodName}
          onChange={(e) => setMethodName(e.target.value)}
        />
        <input
          className="uml-class__add-input"
          aria-label={t('node.methodReturnTypeAria')}
          placeholder={t('node.phReturnType')}
          value={methodReturnType}
          onChange={(e) => setMethodReturnType(e.target.value)}
        />
        <input
          className="uml-class__add-input"
          aria-label={t('node.methodParamsAria')}
          placeholder={t('node.phParams')}
          value={methodParams}
          onChange={(e) => setMethodParams(e.target.value)}
        />
        <label className="uml-class__toggle">
          <input type="checkbox" aria-label={t('node.methodStaticAria')} checked={methodStatic} onChange={(e) => setMethodStatic(e.target.checked)} />
          {t('node.static')}
        </label>
        <button
          type="button"
          className="uml-class__add-button"
          aria-label={t('node.addMethodAria')}
          onClick={submitMethod}
        >
          +
        </button>
        {methodError !== null && (
          <p className="uml-class__validation" role="alert">
            {methodError}
          </p>
        )}
      </div>
      </div>

      {/* Default handles (retained for backward compatibility and test stability) */}
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Top} id="target-top" />
      <Handle type="source" position={Position.Bottom} id="source-bottom" />

      {/* Enterprise Architect multi-point docking handles along all table borders */}
      {/* Left border docking points (25%, 50%, 75%) */}
      <Handle type="source" position={Position.Left} id="left-source" style={{ top: '50%' }} />
      <Handle type="target" position={Position.Left} id="left-top-target" style={{ top: '25%' }} />
      <Handle type="source" position={Position.Left} id="left-top-source" style={{ top: '25%' }} />
      <Handle type="target" position={Position.Left} id="left-bottom-target" style={{ top: '75%' }} />
      <Handle type="source" position={Position.Left} id="left-bottom-source" style={{ top: '75%' }} />

      {/* Right border docking points (25%, 50%, 75%) */}
      <Handle type="target" position={Position.Right} id="right-target" style={{ top: '50%' }} />
      <Handle type="source" position={Position.Right} id="right-top-source" style={{ top: '25%' }} />
      <Handle type="target" position={Position.Right} id="right-top-target" style={{ top: '25%' }} />
      <Handle type="source" position={Position.Right} id="right-bottom-source" style={{ top: '75%' }} />
      <Handle type="target" position={Position.Right} id="right-bottom-target" style={{ top: '75%' }} />

      {/* Top border docking points (25%, 50%, 75%) */}
      <Handle type="source" position={Position.Top} id="top-source" style={{ left: '50%' }} />
      <Handle type="target" position={Position.Top} id="top-left-target" style={{ left: '25%' }} />
      <Handle type="source" position={Position.Top} id="top-left-source" style={{ left: '25%' }} />
      <Handle type="target" position={Position.Top} id="top-right-target" style={{ left: '75%' }} />
      <Handle type="source" position={Position.Top} id="top-right-source" style={{ left: '75%' }} />

      {/* Bottom border docking points (25%, 50%, 75%) */}
      <Handle type="target" position={Position.Bottom} id="bottom-target" style={{ left: '50%' }} />
      <Handle type="source" position={Position.Bottom} id="bottom-left-source" style={{ left: '25%' }} />
      <Handle type="target" position={Position.Bottom} id="bottom-left-target" style={{ left: '25%' }} />
      <Handle type="source" position={Position.Bottom} id="bottom-right-source" style={{ left: '75%' }} />
      <Handle type="target" position={Position.Bottom} id="bottom-right-target" style={{ left: '75%' }} />
      {/* unidad 13c — arrastre para conectar en todo el nodo: mientras una herramienta de borde está armada,
          este handle de origen transparente de nodo completo hace que todo el cuerpo sea un
          inicio de conexión válido (y, en modo flexible, un final válido). NO se
          renderiza cuando no hay herramienta armada, por lo que el arrastre del nodo y la edición
          dentro del nodo se comportan exactamente como antes. */}
      {data.connectArmed === true && (
        <>
          <Handle
            type="source"
            position={Position.Right}
            id="connect-body"
            data-testid="node-connect-overlay"
            className="uml-class__connect-overlay"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: '100%',
              height: '100%',
              minWidth: 0,
              minHeight: 0,
              transform: 'none',
              borderRadius: 0,
              border: 'none',
              background: 'transparent',
              boxShadow: 'none',
              zIndex: 5,
            }}
          />
          <Handle
            type="target"
            position={Position.Left}
            id="connect-body-target"
            data-testid="node-connect-target-overlay"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              width: '100%',
              height: '100%',
              minWidth: 0,
              minHeight: 0,
              transform: 'none',
              borderRadius: 0,
              border: 'none',
              background: 'transparent',
              boxShadow: 'none',
              zIndex: 4,
            }}
          />
        </>
      )}
    </div>
  );
}