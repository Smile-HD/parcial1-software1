/**
 * unidad 13d — Quick Linker estilo EA: el menú posicionado.
 *
 * Una pequeña lista estilo menú contextual renderizada en un ancla de pantalla fija (el
 * punto pointer-up). El MISMO componente sirve para ambos menús de Quick Linker:
 *  - el menú de conectores (tipos de conector válidos entre dos clasificadores);
 *  - el menú de elementos (Class / Interface al soltar en lienzo vacío).
 *
 * Es deliberadamente simple: entran ítems, sale un id. Todo el filtrado de metamodelo ocurre
 * en `quickLinker.ts` (puro), y toda la emisión de deltas vive en DiagramCanvas —
 * por lo que este componente es totalmente testeable solo con props, sin arrastre de puntero.
 * Escape o un clic fuera lo cierran SIN seleccionar nada (onClose).
 */
import { useEffect, useRef } from 'react';

export interface QuickLinkerMenuItem {
  id: string;
  label: string;
}

export interface QuickLinkerMenuProps {
  /** Ancla en pantalla (clientX/clientY en pointer-up). */
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
    // Clic afuera: cualquier pointer-down FUERA del menú lo descarta sin
    // crear nada. Fase de captura para que ningún stopPropagation intermedio
    // pueda ocultarnos el gesto.
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
      // Mantener los controladores del nivel del lienzo (selección de nodo, clic en panel) fuera de los gestos del menú.
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
