/**
 * Configuración de Vitest para @app/web.
 * Polyfills requeridos por @xyflow/react que faltan en jsdom.
 *
 * Mock oficial de React Flow (ver https://reactflow.dev/learn/advanced-use/testing):
 * - ResizeObserver dispara el callback al observar (los nodos deben medirse para que los bordes se rendericen)
 * - offsetWidth/offsetHeight de HTMLElement reportan valores de estilo o 1
 * - getBBox de SVGElement retorna ceros
 */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest se ejecuta sin `globals: true`, por lo que RTL no puede autorregistrar su
// afterEach(cleanup). Sin esto, el DOM se acumula a través de las pruebas en un archivo
// y las consultas por rol/texto encuentran nodos obsoletos de renderizados anteriores.
afterEach(() => {
  cleanup();
});

if (typeof globalThis.ResizeObserver === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class ResizeObserverMock {
    callback: globalThis.ResizeObserverCallback;
    constructor(callback: globalThis.ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(_target: Element): void {
      // Disparar el callback de forma asíncrona para que React Flow pueda medir el contenedor.
      setTimeout(() => {
        this.callback([{ target: _target, contentRect: { width: 800, height: 600 } } as ResizeObserverEntry], this);
      }, 0);
    }
    unobserve(): void { /* noop */ }
    disconnect(): void { /* noop */ }
  }

  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
}

Object.defineProperties(globalThis.HTMLElement.prototype, {
  offsetHeight: {
    get(this: HTMLElement) { return parseFloat(this.style.height) || 1; },
    configurable: true,
  },
  offsetWidth: {
    get(this: HTMLElement) { return parseFloat(this.style.width) || 1; },
    configurable: true,
  },
});

(globalThis.SVGElement.prototype as unknown as Record<string, unknown>).getBBox = () => ({ x: 0, y: 0, width: 0, height: 0 });

if (typeof globalThis.DOMMatrixReadOnly === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class DOMMatrixReadOnlyMock {
    m22: number;
    constructor(transform: string) {
      const scale = transform?.match(/scale\(([1-9.])\)/)?.[1];
      this.m22 = scale !== undefined ? +scale : 1;
    }
  }
  globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyMock as unknown as typeof DOMMatrixReadOnly;
}