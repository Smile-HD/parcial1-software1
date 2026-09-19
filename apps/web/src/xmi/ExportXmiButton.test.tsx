/**
 * Pruebas unitarias para ExportXmiButton (Fase RED de TDD).
 *
 * Contrato de comportamiento:
 * - Renderiza el botón con accesibilidad (aria-label y role).
 * - Deshabilitado cuando el diagrama aún no carga o disabled=true.
 * - Flujo exitoso: invoca GET /diagrams/:id/export/xmi, muestra estado 'Exportando…',
 *   dispara la descarga del archivo en el navegador y muestra 'Exportado'.
 * - Protección contra doble clic: mientras está en vuelo no realiza peticiones duplicadas.
 * - Manejo de error: muestra el mensaje de fallo con role="alert" sin romper la UI.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExportXmiButton } from './ExportXmiButton';

const API_BASE = 'http://localhost:3000';
const EXPORT_ARIA = 'Export diagram as an Enterprise Architect XMI 2.1 file';

/** Helper para construir respuestas simuladas de Blob */
function blobResponse(content = '<xmi:XMI />', status = 200, headers: Record<string, string> = {}): Response {
  const blob = new Blob([content], { type: 'application/xml' });
  return {
    ok: status >= 200 && status < 300,
    status,
    blob: async () => blob,
    json: async () => ({ error: 'Export error' }),
    headers: new Headers(headers),
  } as unknown as Response;
}

/** Promesa diferida para inspeccionar estados intermedios en vuelo */
function deferredResponse(): { promise: Promise<Response>; resolve: (r: Response) => void } {
  let resolveFn: (r: Response) => void = () => {};
  const promise = new Promise<Response>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

describe('ExportXmiButton — renderizado y accesibilidad', () => {
  it('renderiza el botón con su nombre accesible por defecto', () => {
    render(<ExportXmiButton diagramId="diagram-123" />);
    const btn = screen.getByRole('button', { name: EXPORT_ARIA });
    expect(btn).toBeTruthy();
    expect(btn.textContent).toBe('Export XMI');
  });

  it('permanece deshabilitado si diagramId es null', () => {
    render(<ExportXmiButton diagramId={null} />);
    const btn = screen.getByRole('button', { name: EXPORT_ARIA });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });

  it('permanece deshabilitado cuando disabled=true', () => {
    render(<ExportXmiButton diagramId="diagram-123" disabled={true} />);
    const btn = screen.getByRole('button', { name: EXPORT_ARIA });
    expect(btn.hasAttribute('disabled')).toBe(true);
  });
});

describe('ExportXmiButton — flujo de descarga exitoso', () => {
  let createdUrls: string[] = [];
  let clickedLinks: HTMLAnchorElement[] = [];

  beforeEach(() => {
    createdUrls = [];
    clickedLinks = [];
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => {
        const u = 'blob:http://localhost/fake-blob-uuid';
        createdUrls.push(u);
        return u;
      }),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedLinks.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('descarga el archivo XMI y muestra las fases en vuelo y de éxito', async () => {
    const { promise, resolve } = deferredResponse();
    const fetchMock = vi.fn().mockReturnValue(promise);
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportXmiButton diagramId="diagram-abc" />);
    const btn = screen.getByRole('button', { name: EXPORT_ARIA });

    // Clic para iniciar exportación
    fireEvent.click(btn);

    // Debe mostrar la fase "Exporting…"
    expect(btn.textContent).toBe('Exporting…');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${API_BASE}/diagrams/diagram-abc/export/xmi`);

    // Resolver la llamada del servidor
    await act(async () => {
      resolve(blobResponse('<xmi:XMI>sample</xmi:XMI>'));
      await promise;
    });

    // Se dispara la descarga
    await waitFor(() => {
      expect(clickedLinks.length).toBe(1);
    });
    expect(clickedLinks[0].download).toBe('diagram-abc.xmi');

    // Debe mostrar "Exported"
    expect(btn.textContent).toBe('Exported');
  });

  it('ignora múltiples clics mientras una exportación está en vuelo', async () => {
    const { promise, resolve } = deferredResponse();
    const fetchMock = vi.fn().mockReturnValue(promise);
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportXmiButton diagramId="diagram-abc" />);
    const btn = screen.getByRole('button', { name: EXPORT_ARIA });

    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(blobResponse());
      await promise;
    });
  });
});

describe('ExportXmiButton — manejo de errores', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('muestra mensaje de alerta cuando el servidor responde con error', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Diagram not found' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ExportXmiButton diagramId="missing-diagram" />);
    const btn = screen.getByRole('button', { name: EXPORT_ARIA });

    await act(async () => {
      fireEvent.click(btn);
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toBeTruthy();
    expect(alert.textContent).toContain('Diagram not found');
  });
});
