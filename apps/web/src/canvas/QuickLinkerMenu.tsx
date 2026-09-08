/**
 * unit 13d — EA-style Quick Linker: the positioned menu.
 *
 * A small context-menu-style list rendered at a fixed screen anchor (the
 * pointer-up point). The SAME component serves both Quick Linker menus:
 *  - the connector menu (valid connector types between two classifiers);
 *  - the element menu (Class / Interface on an empty-canvas drop).
 *
 * It is deliberately dumb: items in, id-out. All metamodel filtering happens
 * in `quickLinker.ts` (pure), and all delta emission lives in DiagramCanvas —
 * so this component is fully testable with props alone, no pointer drag.
 * Escape or a click-away closes it WITHOUT selecting anything (onClose).
 */
import { useEffect, useRef } from 'react';

export interface QuickLinkerMenuItem {
  id: string;
  label: string;
}

export interface QuickLinkerMenuProps {
  /** Screen anchor (clientX/clientY at pointer-up). */
  position: { x: number; y: number };
  items: readonly QuickLinkerMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function QuickLinkerMenu({ position, items, onSelect, onClose }: QuickLinkerMenuProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    // Click-away: any pointer-down OUTSIDE the menu dismisses it without
    // creating anything. Capture phase so no intermediate stopPropagation
    // can hide the gesture from us.
    const onPointerDown = (event: Event): void => {
      const target = event.target as Node | null;
      if (target !== null && menuRef.current !== null && menuRef.current.contains(target)) {
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="quicklinker-menu"
      role="menu"
      data-testid="quicklinker-menu"
      style={{ position: 'fixed', left: `${position.x}px`, top: `${position.y}px` }}
      // Keep canvas-level handlers (node select, pane click) out of the menu's gestures.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitem"
          aria-label={item.label}
          data-testid={`quicklinker-option-${item.id}`}
          onClick={() => onSelect(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
