import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React, { type ReactNode } from 'react';
import type { EdgeProps, Position } from '@xyflow/react';

import { EdgeCrossingProvider, useOrthogonalPathWithJumps } from './EdgeCrossingContext';

describe('EdgeCrossingContext & useOrthogonalPathWithJumps', () => {
  const dummyProps = (sourceX: number, sourceY: number, targetX: number, targetY: number): EdgeProps => ({
    id: 'test-edge',
    source: 'node-a',
    target: 'node-b',
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition: 'right' as Position,
    targetPosition: 'left' as Position,
    selected: false,
    animated: false,
    data: {},
  });

  it('retorna el path ortogonal sin cambios si no hay intersecciones', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EdgeCrossingProvider>{children}</EdgeCrossingProvider>
    );

    const props = dummyProps(0, 100, 200, 100);
    const { result } = renderHook(() => useOrthogonalPathWithJumps('edge-1', props), { wrapper });

    expect(result.current[0]).toMatch(/M\s*0\s+100/);
    expect(result.current[0]).not.toContain('A 6 6');
  });

  it('agrega un arco de puente cuando una línea horizontal cruza una arista vertical registrada', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EdgeCrossingProvider>{children}</EdgeCrossingProvider>
    );

    // Arista 1: Vertical que va de (100, 0) a (100, 200)
    const verticalProps: EdgeProps = {
      ...dummyProps(100, 0, 100, 200),
      sourcePosition: 'bottom' as Position,
      targetPosition: 'top' as Position,
    };

    // Arista 2: Horizontal que va de (0, 100) a (200, 100)
    const horizontalProps: EdgeProps = {
      ...dummyProps(0, 100, 200, 100),
      sourcePosition: 'right' as Position,
      targetPosition: 'left' as Position,
    };

    // Renderizamos ambas aristas dentro del mismo provider
    const { result } = renderHook(
      () => {
        const vert = useOrthogonalPathWithJumps('edge-vert', verticalProps);
        const horiz = useOrthogonalPathWithJumps('edge-horiz', horizontalProps);
        return { vert, horiz };
      },
      { wrapper },
    );

    // La arista horizontal debe haber detectado el cruce en (100, 100) e insertado el arco
    expect(result.current.horiz[0]).toContain('A 6 6 0 0');
    // La arista vertical nunca salta (sigue continua)
    expect(result.current.vert[0]).not.toContain('A 6 6');
  });
});
