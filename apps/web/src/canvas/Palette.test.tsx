import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Palette, PALETTE_DND_MIME } from './Palette';

/**
 * unit 13b — Palette: the left creation rail. Node items (class/interface) are
 * HTML5-draggable and carry their kind in the dataTransfer; edge items arm an
 * edge tool (click to arm, click again to disarm); the diamond enters the
 * existing n-ary pick mode. These are stable DOM/prop assertions — the actual
 * drag mechanics are covered by direct handler-function tests.
 * unit 13c — the rail is restructured into TWO labeled blocks (Objects /
 * Relations) and gains the Aggregation + Composition association-kind tools.
 */
type EdgeTool =
  | 'association'
  | 'aggregation'
  | 'composition'
  | 'generalization'
  | 'realization'
  | 'dependency';

interface PaletteTestProps {
  activeEdgeTool: EdgeTool | null;
  naryMode: boolean;
  onEdgeToolChange: (tool: EdgeTool | null) => void;
  onNaryModeToggle: () => void;
}

function renderPalette(overrides: Partial<PaletteTestProps> = {}) {
  const props: PaletteTestProps = {
    activeEdgeTool: null,
    naryMode: false,
    onEdgeToolChange: () => {},
    onNaryModeToggle: () => {},
    ...overrides,
  };
  return render(<Palette {...props} />);
}

describe('unit 13b — palette entries (13b.1)', () => {
  it('renders all palette items with stable test ids', () => {
    renderPalette();
    for (const testId of [
      'palette-class',
      'palette-interface',
      'palette-association',
      'palette-aggregation',
      'palette-composition',
      'palette-generalization',
      'palette-realization',
      'palette-dependency',
      'palette-nary',
    ]) {
      expect(screen.getByTestId(testId)).toBeTruthy();
    }
  });

  it('every palette item has an accessible label', () => {
    renderPalette();
    expect(screen.getByTestId('palette-class').getAttribute('aria-label')).toMatch(/class/i);
    expect(screen.getByTestId('palette-interface').getAttribute('aria-label')).toMatch(/interface/i);
    expect(screen.getByTestId('palette-association').getAttribute('aria-label')).toMatch(/association/i);
    expect(screen.getByTestId('palette-generalization').getAttribute('aria-label')).toMatch(/generalization/i);
    expect(screen.getByTestId('palette-realization').getAttribute('aria-label')).toMatch(/realization/i);
    expect(screen.getByTestId('palette-dependency').getAttribute('aria-label')).toMatch(/dependency/i);
    expect(screen.getByTestId('palette-nary').getAttribute('aria-label')).toMatch(/n-ary/i);
  });

  it('class and interface items are HTML5-draggable', () => {
    renderPalette();
    expect(screen.getByTestId('palette-class').getAttribute('draggable')).toBe('true');
    expect(screen.getByTestId('palette-interface').getAttribute('draggable')).toBe('true');
  });

  it('dragging a node item writes its kind into the dataTransfer under the palette mime type', () => {
    renderPalette();
    const setData = vi.fn();
    fireEvent.dragStart(screen.getByTestId('palette-class'), {
      dataTransfer: { setData, getData: () => '', effectAllowed: '', dropEffect: '' },
    });
    expect(setData).toHaveBeenCalledWith(PALETTE_DND_MIME, 'class');

    const setDataIface = vi.fn();
    fireEvent.dragStart(screen.getByTestId('palette-interface'), {
      dataTransfer: { setData: setDataIface, getData: () => '', effectAllowed: '', dropEffect: '' },
    });
    expect(setDataIface).toHaveBeenCalledWith(PALETTE_DND_MIME, 'interface');
  });

  it('clicking an edge item arms that tool', () => {
    const onEdgeToolChange = vi.fn();
    renderPalette({ onEdgeToolChange });
    fireEvent.click(screen.getByTestId('palette-dependency'));
    expect(onEdgeToolChange).toHaveBeenLastCalledWith('dependency');
  });

  it('clicking the already-armed tool again disarms it', () => {
    const disarm = vi.fn();
    renderPalette({ activeEdgeTool: 'realization', onEdgeToolChange: disarm });
    fireEvent.click(screen.getByTestId('palette-realization'));
    expect(disarm).toHaveBeenLastCalledWith(null);
  });

  it('the armed edge tool is exposed via aria-pressed (visual highlight state)', () => {
    const { rerender } = renderPalette();
    expect(screen.getByTestId('palette-generalization').getAttribute('aria-pressed')).toBe('false');
    rerender(
      <Palette
        activeEdgeTool="generalization"
        naryMode={false}
        onEdgeToolChange={() => {}}
        onNaryModeToggle={() => {}}
      />,
    );
    expect(screen.getByTestId('palette-generalization').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('palette-generalization').className).toContain('palette__item--active');
    expect(screen.getByTestId('palette-association').getAttribute('aria-pressed')).toBe('false');
  });

  it('the n-ary entry reflects and toggles the pick-≥3 mode', () => {
    const onNaryModeToggle = vi.fn();
    renderPalette({ naryMode: true, onNaryModeToggle });
    expect(screen.getByTestId('palette-nary').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('palette-nary'));
    expect(onNaryModeToggle).toHaveBeenCalledTimes(1);
  });
});

describe('unit 13c — palette blocks: Objects + Relations with aggregation-kind tools', () => {
  it('renders the two labeled blocks', () => {
    renderPalette();
    expect(screen.getByRole('group', { name: 'Objects' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Relations' })).toBeTruthy();
  });

  it('the Objects block holds exactly Class and Interface', () => {
    renderPalette();
    const objects = screen.getByRole('group', { name: 'Objects' });
    expect(objects.querySelector('[data-testid="palette-class"]')).not.toBeNull();
    expect(objects.querySelector('[data-testid="palette-interface"]')).not.toBeNull();
    expect(objects.querySelector('[data-testid="palette-association"]')).toBeNull();
  });

  it('the Relations block holds all seven relation items', () => {
    renderPalette();
    const relations = screen.getByRole('group', { name: 'Relations' });
    for (const testId of [
      'palette-association',
      'palette-aggregation',
      'palette-composition',
      'palette-generalization',
      'palette-realization',
      'palette-dependency',
      'palette-nary',
    ]) {
      expect(relations.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
    }
  });

  it('aggregation and composition items have accessible labels', () => {
    renderPalette();
    expect(screen.getByTestId('palette-aggregation').getAttribute('aria-label')).toMatch(/aggregation/i);
    expect(screen.getByTestId('palette-composition').getAttribute('aria-label')).toMatch(/composition/i);
  });

  it('clicking aggregation arms the aggregation tool; clicking composition arms composition', () => {
    const onEdgeToolChange = vi.fn();
    renderPalette({ onEdgeToolChange });
    fireEvent.click(screen.getByTestId('palette-aggregation'));
    expect(onEdgeToolChange).toHaveBeenLastCalledWith('aggregation');
    fireEvent.click(screen.getByTestId('palette-composition'));
    expect(onEdgeToolChange).toHaveBeenLastCalledWith('composition');
  });

  it('the armed aggregation tool is highlighted via aria-pressed', () => {
    renderPalette({ activeEdgeTool: 'aggregation' });
    expect(screen.getByTestId('palette-aggregation').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('palette-aggregation').className).toContain('palette__item--active');
  });
});
