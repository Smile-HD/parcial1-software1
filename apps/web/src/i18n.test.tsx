/**
 * unit 13e.7–13e.11 — i18n + chrome STRUCTURAL readback (STRICT TDD: written
 * RED before the implementation batch).
 *
 * Proves the user-visible contract of this unit:
 *  - 13e.7: the obsolete canvas toolbar (Add class / Add interface / Link
 *    classes / N-ary association / Directed) is GONE — the palette + Quick
 *    Linker are the only creation paths.
 *  - 13e.8: the app name is "UML Design Tool" (no "AI") in BOTH languages.
 *  - 13e.9: the EN/ES toggle lives in the app toolbar and switches the shell
 *    strings live (Save → Guardar).
 *  - 13e.10: canvas strings (edge-tool hint, toolbox, class context menu) and
 *    the module-level guard messages follow the current language at call time.
 *  - 13e.11: the palette collapse toggle is wired from the canvas, and the
 *    presence bar renders EA-style chips with user initials.
 *
 * Language state is module-global (i18n store) — every test resets to EN in
 * afterEach so no leakage across files or tests.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildYDocFromDiagram, encodeYDoc, DiagramSchema, type Diagram } from '@app/core';

import { App } from './App';
import { bytesToBase64 } from './api/base64';
import { DiagramCanvas, handleConnectWithTool } from './canvas/DiagramCanvas';
import { PresenceBar } from './canvas/PresenceBar';
import { LANG_STORAGE_KEY, setLang } from './i18n';

beforeEach(() => {
  window.location.hash = '';
});

afterEach(() => {
  setLang('en');
  window.localStorage.removeItem(LANG_STORAGE_KEY);
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function resourceOf(diagram: Diagram, version: number): Record<string, unknown> {
  return {
    id: diagram.id,
    name: diagram.name,
    diagram,
    yjsState: bytesToBase64(encodeYDoc(buildYDocFromDiagram(diagram))),
    version,
    createdAt: 't',
    updatedAt: 't',
  };
}

/** Empty diagram the first-visit POST echoes back (App → ready state). */
function emptyDiagram(): Diagram {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Untitled',
    classes: [],
    associations: [],
    generalizations: [],
    realizations: [],
    dependencies: [],
    naryAssociations: [],
  };
}

/** Stubs the first-visit create flow so <App/> reaches 'ready'. */
function stubCreateFetch(diagram: Diagram): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return Promise.resolve(jsonResponse(resourceOf(diagram, 1)));
      }
      return Promise.reject(new Error(`unexpected fetch ${String(input)}`));
    }),
  );
}

function canvasFixture(): { diagram: Diagram; doc: ReturnType<typeof buildYDocFromDiagram> } {
  const diagram = DiagramSchema.parse({
    id: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'I18n',
    classes: [
      { id: 'aaaaaaaa-0000-4000-8000-0000000000a1', name: 'Alpha', position: { x: 0, y: 0 }, attributes: [], methods: [] },
      { id: 'aaaaaaaa-0000-4000-8000-0000000000a2', name: 'Beta', position: { x: 300, y: 0 }, attributes: [], methods: [] },
    ],
    associations: [],
  });
  return { diagram, doc: buildYDocFromDiagram(diagram) };
}

describe('unit 13e.8 — app name without "AI"', () => {
  it('h1 is exactly "UML Design Tool" (no "AI") in EN and ES', async () => {
    stubCreateFetch(emptyDiagram());
    render(<App />);

    const heading = await screen.findByRole('heading', { level: 1 });
    expect(heading.textContent).toBe('UML Design Tool');
    expect(heading.textContent).not.toMatch(/AI/);

    // Product name: identical in Spanish on purpose.
    setLang('es');
    expect(heading.textContent).toBe('UML Design Tool');
  });
});

describe('unit 13e.7 — obsolete canvas toolbar removed', () => {
  it('renders no legacy toolbar buttons and no toolbar container', () => {
    const { doc } = canvasFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    expect(container.querySelector('.diagram-canvas__toolbar')).toBeNull();
    expect(screen.queryByText('Add class')).toBeNull();
    expect(screen.queryByText('Add interface')).toBeNull();
    expect(screen.queryByText('Link classes')).toBeNull();
    expect(screen.queryByText('Directed')).toBeNull();
  });

  it('the palette collapse toggle is wired by the canvas and collapses the rail', () => {
    const { doc } = canvasFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    const toggle = screen.getByTestId('palette-toggle');
    const rail = container.querySelector('.palette')!;
    expect(rail.classList.contains('palette--collapsed')).toBe(false);

    fireEvent.click(toggle);
    expect(rail.classList.contains('palette--collapsed')).toBe(true);

    fireEvent.click(screen.getByTestId('palette-toggle'));
    expect(rail.classList.contains('palette--collapsed')).toBe(false);
  });
});

describe('unit 13e.9 — language toggle in the app toolbar', () => {
  it('EN/ES buttons live in the toolbar and switch shell + toolbox strings live', async () => {
    stubCreateFetch(emptyDiagram());
    render(<App />);

    // Ready: the palette rail and the toolbar are mounted.
    expect(await screen.findByTestId('palette-class')).toBeTruthy();
    expect(screen.getByTestId('lang-en')).toBeTruthy();
    expect(screen.getByTestId('lang-es')).toBeTruthy();
    expect(screen.getByTestId('toolbar-share').textContent).toContain('Share');
    expect(screen.getByText('Toolbox')).toBeTruthy();

    fireEvent.click(screen.getByTestId('lang-es'));
    expect(screen.getByTestId('toolbar-share').textContent).toContain('Compartir');
    expect(screen.getByText('Caja de herramientas')).toBeTruthy();
    expect(screen.queryByText('Toolbox')).toBeNull();

    fireEvent.click(screen.getByTestId('lang-en'));
    expect(screen.getByText('Toolbox')).toBeTruthy();
  });
});

describe('unit 13e.10 — canvas + guard strings follow the language', () => {
  it('the armed edge-tool hint renders in the current language', () => {
    setLang('es');
    const { doc } = canvasFixture();
    render(<DiagramCanvas doc={doc} />);

    fireEvent.click(screen.getByTestId('palette-association'));
    const hint = screen.getByTestId('edge-tool-hint');
    expect(hint.textContent).toContain('Herramienta Asociación activa');
  });

  it('the class context menu is localized', () => {
    setLang('es');
    const { doc } = canvasFixture();
    const { container } = render(<DiagramCanvas doc={doc} />);

    const node = container.querySelector('.react-flow__node')!.querySelector('.uml-class')!;
    fireEvent.contextMenu(node);

    expect(screen.getByText('Marcar como abstracta')).toBeTruthy();
    expect(screen.getByText('Cerrar')).toBeTruthy();
  });

  it('exported guard handlers translate at CALL time (module-level t)', () => {
    const { diagram, doc } = canvasFixture();
    const classifiers = diagram.classes.map((c) => ({ id: c.id, kind: 'class' as const }));

    setLang('es');
    const result = handleConnectWithTool(
      doc,
      diagram.id,
      'realization',
      { source: diagram.classes[0]!.id, target: diagram.classes[1]!.id },
      classifiers,
    );
    expect(result.ok).toBe(false);
    expect(result.message).toBe('Una realización debe apuntar a una interfaz («interface»).');

    setLang('en');
    const english = handleConnectWithTool(
      doc,
      diagram.id,
      'realization',
      { source: diagram.classes[0]!.id, target: diagram.classes[1]!.id },
      classifiers,
    );
    expect(english.message).toBe('A realization must target an interface («interface»).');
  });
});

describe('unit 13e.11 — EA-style presence chips', () => {
  it('each user chip renders an initials avatar + online dot + name', () => {
    const { container } = render(<PresenceBar names={['User-a1b2', 'Ana López']} />);

    const bar = container.querySelector('.presence-bar')!;
    expect(bar.getAttribute('aria-label')).toBe('Online users');

    const avatars = container.querySelectorAll('.presence-bar__avatar');
    expect(avatars).toHaveLength(2);
    expect(avatars[0]!.textContent).toBe('UA');
    expect(avatars[1]!.textContent).toBe('AL');

    expect(container.querySelectorAll('.presence-bar__dot')).toHaveLength(2);
    expect(screen.getByText('User-a1b2')).toBeTruthy();
    expect(screen.getByText('Ana López')).toBeTruthy();
  });

  it('presence aria-label switches with the language', () => {
    setLang('es');
    const { container } = render(<PresenceBar names={['User-a1b2']} />);
    expect(container.querySelector('.presence-bar')!.getAttribute('aria-label')).toBe('Usuarios en línea');
  });
});
