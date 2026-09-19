import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CanvasErrorBoundary } from './CanvasErrorBoundary';

function FaultyChild({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Canvas render crashed');
  }
  return <div data-testid="healthy-canvas">Canvas is running smoothly</div>;
}

describe('CanvasErrorBoundary', () => {
  it('renders children normally when no error occurs', () => {
    render(
      <CanvasErrorBoundary>
        <FaultyChild shouldThrow={false} />
      </CanvasErrorBoundary>,
    );

    expect(screen.getByTestId('healthy-canvas')).toBeTruthy();
  });

  it('catches render error and displays recovery fallback instead of blank screen', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <CanvasErrorBoundary>
        <FaultyChild shouldThrow={true} />
      </CanvasErrorBoundary>,
    );

    expect(screen.getByTestId('canvas-error-boundary')).toBeTruthy();
    expect(screen.getByText('Error al renderizar el lienzo')).toBeTruthy();
    expect(screen.getByText('Canvas render crashed')).toBeTruthy();
    expect(screen.getByTestId('canvas-error-reset')).toBeTruthy();

    consoleSpy.mockRestore();
  });

  it('resets error state when reset button is clicked', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { rerender } = render(
      <CanvasErrorBoundary>
        <FaultyChild shouldThrow={true} />
      </CanvasErrorBoundary>,
    );

    expect(screen.getByTestId('canvas-error-boundary')).toBeTruthy();

    // Fix problem and click reset
    rerender(
      <CanvasErrorBoundary>
        <FaultyChild shouldThrow={false} />
      </CanvasErrorBoundary>,
    );

    fireEvent.click(screen.getByTestId('canvas-error-reset'));
    expect(screen.getByTestId('healthy-canvas')).toBeTruthy();

    consoleSpy.mockRestore();
  });
});
