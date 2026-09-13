import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { buildYDocFromDiagram, type Diagram } from '@app/core';

import { ExportToolbarButtons } from './imageExport';

function makeDiagram(): Diagram {
  return {
    id: 'test-id',
    name: 'TestDiagram',
    classes: [
      {
        id: 'c1',
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
});
