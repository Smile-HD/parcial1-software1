import type { FastifyInstance } from 'fastify';
import { exportDiagramToXmi } from '@app/adapters-import';
import { loadDiagramById, DiagramNotFoundError } from './index.js';

export function registerXmiExportRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    '/diagrams/:id/export/xmi',
    async (request, reply) => {
      const diagramId = request.params.id;

      let diagram;
      try {
        ({ diagram } = await loadDiagramById(diagramId));
      } catch (error) {
        if (error instanceof DiagramNotFoundError) {
          return reply.status(404).send({ error: 'Diagram not found' });
        }
        return reply
          .status(500)
          .send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }

      const xmi = exportDiagramToXmi(diagram);
      const safeName = String(diagram.name).replace(/[^a-zA-Z0-9_-]/g, '_');

      return reply
        .header('Content-Type', 'application/xml')
        .header('Content-Disposition', `attachment; filename="${safeName}.xmi"`)
        .send(xmi);
    }
  );
}
