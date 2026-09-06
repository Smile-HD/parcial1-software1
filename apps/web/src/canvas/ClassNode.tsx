/**
 * UML class node rendered inside a React Flow canvas.
 * Handles are placed left (target) and right (source) for association edges.
 *
 * editor:R2 — inline rename: double-click the title to edit; commit on
 * blur/Enter (via the onRename callback, which emits a rename delta).
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { Attribute, ClassKind, Method, Parameter, Visibility } from '@app/core';

/** UML adornments carried by member add/edit operations (unit 9). */
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
  /** Unit 12.1: classifier kind ('class' | 'interface') and abstract marking. */
  kind: ClassKind;
  isAbstract: boolean;
  /** Other classes in the diagram — candidates for "make subclass of" (unit 11.4). */
  otherClasses: readonly { id: string; name: string }[];
  /** Interfaces in the diagram — candidates for "realize" (unit 12.4). */
  otherInterfaces: readonly { id: string; name: string }[];
  onRename: (newName: string) => void;
  onDelete: () => void;
  onAddAttribute: (name: string, type: string, adornments?: MemberAdornments) => void;
  onEditAttribute: (memberId: string, name: string, type: string, adornments?: MemberAdornments) => void;
  onRemoveAttribute: (memberId: string) => void;
  onAddMethod: (name: string, returnType: string, parameters: Parameter[], adornments?: MemberAdornments) => void;
  onEditMethod: (memberId: string, name: string, returnType: string, parameters: Parameter[], adornments?: MemberAdornments) => void;
  onRemoveMethod: (memberId: string) => void;
  /** Unit 11.4: emit a generalization create with this class as the subClass. */
  onMakeSubclass: (superClassId: string) => void;
  /** Unit 12.4: toggle the abstract marker via a class update delta. */
  onToggleAbstract: (isAbstract: boolean) => void;
  /** Unit 12.4: emit a realization create with this class as the client. */
  onRealize: (supplierInterfaceId: string) => void;
  /** Unit 12.4 (12b): emit a dependency create with this class as the client. */
  onDependOn: (supplierClassId: string) => void;
  /** Unit 11.4: select this class to show its generalization list in the panel. */
  onSelect: () => void;
  /**
   * Unit 13c — node-wide drag-to-connect: when an edge tool is armed the
   * canvas renders a full-node transparent source handle so a connection can
   * START anywhere on the body, not just on the small handle dots. When not
   * armed the overlay does not exist, so node dragging is untouched.
   */
  connectArmed?: boolean;
  /**
   * Unit 13d — EA-style Quick Linker: true when this node is the canvas's
   * selected element. The corner arrow renders ONLY then (hidden otherwise).
   */
  selected?: boolean;
  /**
   * Unit 13d — pointer-down on the Quick Linker arrow starts the quick-link
   * drag; the canvas tracks the cursor and resolves the drop (connector menu
   * over an element, element menu over empty canvas).
   */
  onQuickLinkStart?: (clientX: number, clientY: number) => void;
};

export type ClassFlowNode = import('@xyflow/react').Node<ClassNodeData, 'class'>;

/**
 * editor:R3 — comma-separated parameter entries of the form `name: type`;
 * a missing type defaults to `any`. Blank entries are dropped so the
 * emitted delta always satisfies MemberDeltaSchema (parameter name/type min 1).
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
 * UML 2.5.1 member rendering (unit 9.3): visibility prefix, `/` for derived,
 * `[mult]` after the type, static names underlined via the CSS class.
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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.name);
  const doneRef = useRef(false);

  // Unit 11.4 — class context menu ("make subclass of").
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

  // editor:R3 — in-place member editing state (one member edited at a time).
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
    // editor:R3 — blank-name attributes are rejected before any delta is emitted,
    // so the model (Y.Doc) stays unchanged.
    if (name.length === 0) {
      setAttrError('Attribute name is required');
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
    // editor:R3 — blank-name methods are rejected before any delta is emitted,
    // so the model (Y.Doc) stays unchanged. A blank return type defaults to
    // `void` so the emitted delta always satisfies MemberDeltaSchema (min 1).
    if (name.length === 0) {
      setMethodError('Method name is required');
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
   * editor:R3 — commit an in-place member edit. A blank name or (return) type
   * is rejected BEFORE any delta is emitted: core's `DeltaSchema.parse`
   * throws on min(1) strings, so this guard keeps the model (Y.Doc)
   * unchanged and shows a validation message instead.
   */
  const commitEdit = (): void => {
    if (editingMember === null) {
      return;
    }
    const name = editName.trim();
    const type = editType.trim();
    if (name.length === 0 || type.length === 0) {
      setEditError('Name and type are required');
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
      className={`uml-class${isInterface ? ' uml-class--interface' : ''}`}
      onClick={data.onSelect}
      onContextMenu={(event) => {
        // editor:R Generalization (unit 11.4) — right-click opens the
        // "make subclass of" menu; the browser menu is suppressed.
        // Unit 12.4 adds "realize <interface>" and the abstract toggle.
        event.preventDefault();
        setMenuOpen(true);
      }}
    >
      {menuOpen && (
        <div className="uml-class__context-menu" role="menu" data-testid="class-context-menu">
          {data.otherClasses.length === 0 ? (
            <span className="uml-class__context-empty">No other classes</span>
          ) : (
            data.otherClasses.map((other) => (
              <button
                key={other.id}
                type="button"
                role="menuitem"
                aria-label={`Make subclass of ${other.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  data.onMakeSubclass(other.id);
                  setMenuOpen(false);
                }}
              >
                Make subclass of {other.name}
              </button>
            ))
          )}
          {/* Unit 12.4 — realize an interface (client = this class). Interfaces only:
              the engine rejects non-interface suppliers anyway. */}
          {data.otherInterfaces.map((iface) => (
            <button
              key={iface.id}
              type="button"
              role="menuitem"
              aria-label={`Realize ${iface.name}`}
              onClick={(event) => {
                event.stopPropagation();
                data.onRealize(iface.id);
                setMenuOpen(false);
              }}
            >
              Realize {iface.name}
            </button>
          ))}
          {/* Unit 12.4 (12b) — depends on (client = this class). The supplier may
              be ANY other classifier (class or interface) — unlike realization. */}
          {data.otherClasses.map((other) => (
            <button
              key={`dep-${other.id}`}
              type="button"
              role="menuitem"
              aria-label={`Depends on ${other.name}`}
              onClick={(event) => {
                event.stopPropagation();
                data.onDependOn(other.id);
                setMenuOpen(false);
              }}
            >
              Depends on {other.name}
            </button>
          ))}
          {/* Unit 12.4 — abstract toggle (interfaces are implicitly abstract; hide it there). */}
          {!isInterface && (
            <button
              type="button"
              role="menuitem"
              aria-label={data.isAbstract ? 'Unmark abstract' : 'Mark abstract'}
              onClick={(event) => {
                event.stopPropagation();
                data.onToggleAbstract(!data.isAbstract);
                setMenuOpen(false);
              }}
            >
              {data.isAbstract ? 'Unmark abstract' : 'Mark abstract'}
            </button>
          )}
          <button
            type="button"
            aria-label="Close context menu"
            onClick={(event) => {
              event.stopPropagation();
              setMenuOpen(false);
            }}
          >
            Close
          </button>
        </div>
      )}
      {/* unit 13d — EA-style Quick Linker: the corner arrow at the TOP-RIGHT
          of the SELECTED element. Pointer-down starts a quick-link drag
          (connector menu over a target element, element menu over empty
          canvas). Hidden when the node is not selected; `nodrag` keeps React
          Flow from turning the gesture into a node move. */}
      {data.selected === true && (
        <button
          type="button"
          className="uml-class__quicklinker nodrag nopan"
          data-testid="quicklinker-arrow"
          aria-label="Quick Linker"
          title="Drag to another element to link, or to empty canvas to create and link"
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
          {/* Unit 12.1 — UML stereotype header for interfaces. */}
          {isInterface && <div className="uml-class__stereotype">«interface»</div>}
          <span className={`uml-class__name${isItalicName ? ' uml-class__name--italic' : ''}`}>{data.name}</span>
          <button
            type="button"
            className="uml-class__delete"
            aria-label={`Delete ${data.name}`}
            onClick={data.onDelete}
          >
            ×
          </button>
        </div>
      )}

      {data.attributes.length > 0 && (
        <div className="uml-class__section">
          {data.attributes.map((attr) =>
            editingMember?.kind === 'attribute' && editingMember.id === attr.id ? (
              <div key={attr.id} className="uml-class__member uml-class__edit">
                <input
                  className="uml-class__add-input"
                  aria-label="Edit attribute name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  {...editKeyHandlers}
                />
                <input
                  className="uml-class__add-input"
                  aria-label="Edit attribute type"
                  value={editType}
                  onChange={(e) => setEditType(e.target.value)}
                  {...editKeyHandlers}
                />
                <button
                  type="button"
                  className="uml-class__add-button"
                  aria-label="Confirm edit"
                  onClick={commitEdit}
                >
                  ✓
                </button>
                <button
                  type="button"
                  className="uml-class__remove"
                  aria-label="Cancel edit"
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
                  aria-label={`Edit attribute ${attr.name}`}
                  onClick={() => startEditAttribute(attr)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="uml-class__remove"
                  aria-label={`Remove attribute ${attr.name}`}
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
          aria-label="Attribute visibility"
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
          aria-label="Attribute name"
          placeholder="name"
          value={attrName}
          onChange={(e) => setAttrName(e.target.value)}
        />
        <input
          className="uml-class__add-input"
          aria-label="Attribute type"
          placeholder="type"
          value={attrType}
          onChange={(e) => setAttrType(e.target.value)}
        />
        <input
          className="uml-class__add-input"
          aria-label="Attribute multiplicity"
          placeholder="[0..*]"
          value={attrMultiplicity}
          onChange={(e) => setAttrMultiplicity(e.target.value)}
        />
        <label className="uml-class__toggle">
          <input type="checkbox" aria-label="Attribute static" checked={attrStatic} onChange={(e) => setAttrStatic(e.target.checked)} />
          static
        </label>
        <label className="uml-class__toggle">
          <input type="checkbox" aria-label="Attribute derived" checked={attrDerived} onChange={(e) => setAttrDerived(e.target.checked)} />
          derived
        </label>
        <button
          type="button"
          className="uml-class__add-button"
          aria-label="Add attribute"
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

      {data.methods.length > 0 && (
        <div className="uml-class__section">
          {data.methods.map((method) => {
            if (editingMember?.kind === 'method' && editingMember.id === method.id) {
              return (
                <div key={method.id} className="uml-class__member uml-class__edit">
                  <input
                    className="uml-class__add-input"
                    aria-label="Edit method name"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    {...editKeyHandlers}
                  />
                  <input
                    className="uml-class__add-input"
                    aria-label="Edit method return type"
                    value={editType}
                    onChange={(e) => setEditType(e.target.value)}
                    {...editKeyHandlers}
                  />
                  <input
                    className="uml-class__add-input"
                    aria-label="Edit method parameters"
                    placeholder="param: type, ..."
                    value={editParams}
                    onChange={(e) => setEditParams(e.target.value)}
                    {...editKeyHandlers}
                  />
                  <button
                    type="button"
                    className="uml-class__add-button"
                    aria-label="Confirm edit"
                    onClick={commitEdit}
                  >
                    ✓
                  </button>
                  <button
                    type="button"
                    className="uml-class__remove"
                    aria-label="Cancel edit"
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
                  aria-label={`Edit method ${method.name}`}
                  onClick={() => startEditMethod(method)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className="uml-class__remove"
                  aria-label={`Remove method ${method.name}`}
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
          aria-label="Method visibility"
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
          aria-label="Method name"
          placeholder="name"
          value={methodName}
          onChange={(e) => setMethodName(e.target.value)}
        />
        <input
          className="uml-class__add-input"
          aria-label="Method return type"
          placeholder="return type"
          value={methodReturnType}
          onChange={(e) => setMethodReturnType(e.target.value)}
        />
        <input
          className="uml-class__add-input"
          aria-label="Method parameters"
          placeholder="param: type, ..."
          value={methodParams}
          onChange={(e) => setMethodParams(e.target.value)}
        />
        <label className="uml-class__toggle">
          <input type="checkbox" aria-label="Method static" checked={methodStatic} onChange={(e) => setMethodStatic(e.target.checked)} />
          static
        </label>
        <button
          type="button"
          className="uml-class__add-button"
          aria-label="Add method"
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

      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      {/* unit 13c — node-wide drag-to-connect: while an edge tool is armed,
          this transparent full-node source handle makes the whole body a
          valid connection start (and, in loose mode, a valid end). It is NOT
          rendered when no tool is armed, so node dragging and in-node
          editing behave exactly as before. */}
      {data.connectArmed === true && (
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
      )}
    </div>
  );
}