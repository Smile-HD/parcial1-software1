/**
 * UML class node rendered inside a React Flow canvas.
 * Handles are placed left (target) and right (source) for association edges.
 *
 * editor:R2 — inline rename: double-click the title to edit; commit on
 * blur/Enter (via the onRename callback, which emits a rename delta).
 */
import { useRef, useState, type KeyboardEvent } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';

import type { Attribute, Method, Parameter } from '@app/core';

export type ClassNodeData = Record<string, unknown> & {
  name: string;
  attributes: readonly Attribute[];
  methods: readonly Method[];
  onRename: (newName: string) => void;
  onDelete: () => void;
  onAddAttribute: (name: string, type: string) => void;
  onEditAttribute: (memberId: string, name: string, type: string) => void;
  onRemoveAttribute: (memberId: string) => void;
  onAddMethod: (name: string, returnType: string, parameters: Parameter[]) => void;
  onEditMethod: (memberId: string, name: string, returnType: string, parameters: Parameter[]) => void;
  onRemoveMethod: (memberId: string) => void;
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

export function ClassNode({ data }: NodeProps<ClassFlowNode>) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.name);
  const doneRef = useRef(false);

  const [attrName, setAttrName] = useState('');
  const [attrType, setAttrType] = useState('');
  const [attrError, setAttrError] = useState<string | null>(null);

  const [methodName, setMethodName] = useState('');
  const [methodReturnType, setMethodReturnType] = useState('');
  const [methodParams, setMethodParams] = useState('');
  const [methodError, setMethodError] = useState<string | null>(null);

  // editor:R3 — in-place member editing state (one member edited at a time).
  const [editingMember, setEditingMember] = useState<
    { kind: 'attribute' | 'method'; id: string } | null
  >(null);
  const [editName, setEditName] = useState('');
  const [editType, setEditType] = useState('');
  const [editParams, setEditParams] = useState('');
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
    data.onAddAttribute(name, type);
    setAttrName('');
    setAttrType('');
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
    data.onAddMethod(name, methodReturnType.trim() || 'void', parseParameters(methodParams));
    setMethodName('');
    setMethodReturnType('');
    setMethodParams('');
  };

  const startEditAttribute = (attr: Attribute): void => {
    setEditingMember({ kind: 'attribute', id: attr.id });
    setEditName(attr.name);
    setEditType(attr.type);
    setEditParams('');
    setEditError(null);
  };

  const startEditMethod = (method: Method): void => {
    setEditingMember({ kind: 'method', id: method.id });
    setEditName(method.name);
    setEditType(method.returnType);
    setEditParams(method.parameters.map((param) => `${param.name}: ${param.type}`).join(', '));
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
      data.onEditAttribute(editingMember.id, name, type);
    } else {
      data.onEditMethod(editingMember.id, name, type, parseParameters(editParams));
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

  return (
    <div className="uml-class">
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
          <span className="uml-class__name">{data.name}</span>
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
                <span className="uml-class__member-text">
                  {attr.name}: {attr.type}
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
                <span className="uml-class__member-text">
                  {method.name}({params}): {method.returnType}
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
    </div>
  );
}