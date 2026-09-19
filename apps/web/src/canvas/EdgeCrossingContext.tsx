/**
 * Contexto y Provider para la coordinación de saltos de línea (Line Jumps estilo Enterprise Architect)
 * entre múltiples aristas del lienzo.
 *
 * Registra los segmentos ortogonales de cada arista conectora y permite que las líneas horizontales
 * consulten en tiempo de render las líneas verticales que las intersecan para dibujar arcos de puente.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getSmoothStepPath, type EdgeProps } from '@xyflow/react';

import {
  addBridgeJumps,
  findCrossingPoints,
  parseOrthogonalSegments,
  type Segment,
} from './edgeCrossings';

interface EdgeCrossingRegistry {
  registerEdge: (id: string, horizontals: Segment[], verticals: Segment[]) => void;
  unregisterEdge: (id: string) => void;
  getOtherVerticals: (id: string) => Segment[];
  subscribe: (listener: () => void) => () => void;
}

const EdgeCrossingCtx = createContext<EdgeCrossingRegistry | null>(null);

export function EdgeCrossingProvider({ children }: { children: ReactNode }) {
  const segmentsMap = useRef<Map<string, { horizontals: Segment[]; verticals: Segment[] }>>(
    new Map(),
  );
  const listeners = useRef<Set<() => void>>(new Set());

  const subscribe = useCallback((listener: () => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  const registerEdge = useCallback(
    (id: string, horizontals: Segment[], verticals: Segment[]) => {
      const prev = segmentsMap.current.get(id);
      const isSame =
        prev !== undefined &&
        prev.horizontals.length === horizontals.length &&
        prev.verticals.length === verticals.length &&
        prev.horizontals.every(
          (h, i) =>
            h.x1 === horizontals[i]?.x1 &&
            h.y1 === horizontals[i]?.y1 &&
            h.x2 === horizontals[i]?.x2 &&
            h.y2 === horizontals[i]?.y2,
        ) &&
        prev.verticals.every(
          (v, i) =>
            v.x1 === verticals[i]?.x1 &&
            v.y1 === verticals[i]?.y1 &&
            v.x2 === verticals[i]?.x2 &&
            v.y2 === verticals[i]?.y2,
        );

      segmentsMap.current.set(id, { horizontals, verticals });

      if (!isSame) {
        // Notificar a los observadores para recalcular arcos si hubo cambio
        for (const listener of listeners.current) {
          listener();
        }
      }
    },
    [],
  );

  const unregisterEdge = useCallback((id: string) => {
    if (segmentsMap.current.delete(id)) {
      for (const listener of listeners.current) {
        listener();
      }
    }
  }, []);

  const getOtherVerticals = useCallback((id: string): Segment[] => {
    const others: Segment[] = [];
    for (const [edgeId, entry] of segmentsMap.current.entries()) {
      if (edgeId !== id) {
        others.push(...entry.verticals);
      }
    }
    return others;
  }, []);

  const registry = useMemo<EdgeCrossingRegistry>(
    () => ({
      registerEdge,
      unregisterEdge,
      getOtherVerticals,
      subscribe,
    }),
    [registerEdge, unregisterEdge, getOtherVerticals, subscribe],
  );

  return <EdgeCrossingCtx.Provider value={registry}>{children}</EdgeCrossingCtx.Provider>;
}

/**
 * Hook para aristas ortogonales: calcula la ruta con getSmoothStepPath, registra sus segmentos
 * y añade arcos de puente en los puntos de cruce con otras aristas.
 */
export function useOrthogonalPathWithJumps(
  id: string,
  props: EdgeProps,
): [path: string, labelX: number, labelY: number, offsetX: number, offsetY: number] {
  const [rawPath, labelX, labelY, offsetX, offsetY] = getSmoothStepPath(props);
  const context = useContext(EdgeCrossingCtx);

  // Parsea segmentos ortogonales de la ruta actual
  const { horizontals, verticals } = useMemo(
    () => parseOrthogonalSegments(rawPath),
    [rawPath],
  );

  // Si no hay contexto de cruces (pruebas unitarias aisladas), devolver el path nativo
  if (!context) {
    return [rawPath, labelX, labelY, offsetX, offsetY];
  }

  // Registra inmediatamente durante el render para que aristas posteriores la conozcan
  context.registerEdge(id, horizontals, verticals);

  // Efecto para desregistrar la arista al desmontarse
  useEffect(() => {
    return () => {
      context.unregisterEdge(id);
    };
  }, [context, id]);

  // Obtener segmentos verticales de las demás aristas para detectar cruces
  const otherVerticals = context.getOtherVerticals(id);
  const crossings = findCrossingPoints(horizontals, otherVerticals);

  const pathWithJumps = crossings.length > 0 ? addBridgeJumps(rawPath, crossings) : rawPath;

  return [pathWithJumps, labelX, labelY, offsetX, offsetY];
}
