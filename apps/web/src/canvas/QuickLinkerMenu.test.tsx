/**
 * unit 13d — EA-style Quick Linker: the positioned menu component.
 *
 * The Quick Linker gesture (pointer-drag) cannot run in jsdom, but the menu
 * it opens is a plain component driven by props — so its full behavior
 * (render, pick, Escape, click-away) is directly testable here. The canvas
 * wires this same component to the drag result.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { QuickLinkerMenu, type QuickLinkerMenuItem } from './QuickLinkerMenu';

const ITEMS: QuickLinkerMenuItem[] = [
  { id: 'association', label: 'Association' },
  { id: 'generalization', label: 'Generalization' },
  { id: 'realization', label: 'Realization' },
];

function renderMenu(overrides: Partial<Parameters<typeof QuickLinkerMenu>[0]> = {}) {
  const onSelect = vi.fn();
  const onClose = vi.fn();
  const utils = render(
    <QuickLinkerMenu
      position={{ x: 120, y: 240 }}
      items={ITEMS}
      onSelect={onSelect}
      onClose={onClose}
      {...overrides}
    />,
  );
  return { ...utils, onSelect, onClose };
}

describe('unit 13d — QuickLinkerMenu rendering', () => {
  it('renders a positioned menu with one menuitem per option', () => {
    renderMenu();
    const menu = screen.getByTestId('quicklinker-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    const buttons = menu.querySelectorAll('button[role="menuitem"]');
    expect(buttons).toHaveLength(3);
    expect(screen.getByRole('menuitem', { name: 'Association' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Realization' })).toBeTruthy();
  });

  it('positions itself at the given anchor (fixed, so canvas pan cannot skew it)', () => {
    renderMenu({ position: { x: 33, y: 77 } });
    const menu = screen.getByTestId('quicklinker-menu') as HTMLElement;
    expect(menu.style.position).toBe('fixed');
    expect(menu.style.left).toBe('33px');
    expect(menu.style.top).toBe('77px');
  });
});

describe('unit 13d — QuickLinkerMenu interactions', () => {
  it('clicking an item reports its id through onSelect', () => {
    const { onSelect } = renderMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Generalization' }));
    expect(onSelect).toHaveBeenCalledWith('generalization');
  });

  it('Escape closes the menu without selecting anything', () => {
    const { onSelect, onClose } = renderMenu();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a pointer-down outside the menu closes it without selecting anything', () => {
    const { onSelect, onClose } = renderMenu();
    fireEvent.pointerDown(document.body, { clientX: 999, clientY: 999 });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a pointer-down INSIDE the menu does not close it (the click belongs to an item)', () => {
    const { onClose } = renderMenu();
    fireEvent.pointerDown(screen.getByRole('menuitem', { name: 'Association' }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
