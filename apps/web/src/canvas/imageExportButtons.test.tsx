import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildYDocFromDiagram, type Diagram } from '@app/core';

import { ExportPreviewModal, ExportToolbarButtons } from './imageExport';

vi.mock('html-to-image', () => ({
  toPng: vi.fn().mockResolvedValue('data:image/png;base64,FAKEPNG'),
  toJpeg: vi.fn().mockResolvedValue('data:image/jpeg;base64,FAKEJPEG'),
}));

function makeDiagram(): Diagram {
  return {
    id: crypto.randomUUID(),
    name: 'TestDiagram',
    classes: [
      {
        id: crypto.randomUUID(),
        name: 'A',
        position: { x: 0, y: 0 },
        attributes: [],
        methods: [],
        kind: 'class',
        isAbstract: false,
      },
    ],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  };
}

describe('ExportToolbarButtons', () => {
  let viewportEl: HTMLDivElement;

  beforeEach(() => {
    viewportEl = document.createElement('div');
    viewportEl.className = 'react-flow__viewport';
    document.body.appendChild(viewportEl);
  });

  afterEach(() => {
    if (viewportEl.parentElement) {
      viewportEl.parentElement.removeChild(viewportEl);
    }
  });

  it('renders Export PNG and Export JPEG buttons', () => {
    const doc = buildYDocFromDiagram(makeDiagram());
    render(<ExportToolbarButtons doc={doc} diagramName="Test" diagramId="test-id" />);
    expect(screen.getByRole('button', { name: /export png/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /export jpeg/i })).toBeTruthy();
  });

  it('Export PNG button has correct data-testid', () => {
    const doc = buildYDocFromDiagram(makeDiagram());
    render(<ExportToolbarButtons doc={doc} diagramName="Test" diagramId="test-id" />);
    expect(screen.getByTestId('export-png')).toBeTruthy();
  });

  it('Export JPEG button has correct data-testid', () => {
    const doc = buildYDocFromDiagram(makeDiagram());
    render(<ExportToolbarButtons doc={doc} diagramName="Test" diagramId="test-id" />);
    expect(screen.getByTestId('export-jpeg')).toBeTruthy();
  });

  it('opens ExportPreviewModal on clicking Export PNG', async () => {
    const doc = buildYDocFromDiagram(makeDiagram());
    render(<ExportToolbarButtons doc={doc} diagramName="Test" diagramId="test-id" />);

    fireEvent.click(screen.getByTestId('export-png'));

    await waitFor(() => {
      expect(screen.getByTestId('export-preview-modal')).toBeTruthy();
    });

    const img = screen.getByTestId('export-preview-image') as HTMLImageElement;
    expect(img.src).toBe('data:image/png;base64,FAKEPNG');

    // Clicking cancel closes the modal
    fireEvent.click(screen.getByTestId('export-preview-cancel'));
    await waitFor(() => {
      expect(screen.queryByTestId('export-preview-modal')).toBeNull();
    });
  });
});

describe('ExportPreviewModal', () => {
  it('renders preview details and handles action buttons', () => {
    const onDownload = vi.fn();
    const onClose = vi.fn();

    render(
      <ExportPreviewModal
        preview={{
          dataUrl: 'data:image/png;base64,TEST',
          filename: 'Diagram_123.png',
          format: 'png',
          width: 800,
          height: 600,
        }}
        onDownload={onDownload}
        onClose={onClose}
      />,
    );

    expect(screen.getByTestId('export-preview-modal')).toBeTruthy();
    expect(screen.getByText('Diagram_123.png')).toBeTruthy();
    expect(screen.getByText('800 × 600 px')).toBeTruthy();

    fireEvent.click(screen.getByTestId('export-preview-download'));
    expect(onDownload).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('export-preview-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape key press', () => {
    const onClose = vi.fn();
    render(
      <ExportPreviewModal
        preview={{
          dataUrl: 'data:image/png;base64,TEST',
          filename: 'Test.png',
          format: 'png',
        }}
        onDownload={vi.fn()}
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
