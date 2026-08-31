/**
 * Vitest setup for @app/web.
 * Polyfills required by @xyflow/react that are missing in jsdom.
 *
 * React Flow's official mock (see https://reactflow.dev/learn/advanced-use/testing):
 * - ResizeObserver fires callback on observe (nodes need to be measured for edges to render)
 * - HTMLElement offsetWidth/offsetHeight report style values or 1
 * - SVGElement getBBox returns zeros
 */

import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// vitest runs without `globals: true`, so RTL cannot auto-register its
// afterEach(cleanup). Without this, DOM accumulates across tests in a file
// and role/text queries find stale nodes from earlier renders.
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
      // Fire callback async so React Flow can measure the container.
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