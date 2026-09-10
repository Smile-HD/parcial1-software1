import type { FastifyInstance } from 'fastify';
import { parseXmiDocument, xmiToDeltaBatch } from '../../../packages/adapters-import/src/xmi21.js';
import { loadDiagramById } from './index.js';

export function registerXmiImportRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: { xmi: string } }>(
    '/diagrams/:id/import/xmi',
    { schema: { body: { type: 'object', required: ['xmi'], properties: { xmi: { type: 'string' } } } } },
    async (request, reply) => {
      const diagramId = request.params.id;
      const { xmi } = request.body;

      // Check if diagram exists
      const diagram = await loadDiagramById(diagramId);
      if (!diagram) {
        return reply.status(404).send({ error: 'Diagram not found' });
      }

      let model;
      try {
        model = parseXmiDocument(xmi);
      } catch (err: any) {
        return reply.status(400).send({ error: err.message || 'Invalid XMI' });
      }

      const batch = xmiToDeltaBatch(model, diagramId);

      // PR 15 web apply path: return the parsed deltas so the web client can
      // apply them straight to its Y.Doc. The original AI-interpreter-style
      // pending-store path is unused here because the import is a batch
      // (N deltas), not a single delta, and PendingDeltaStore is shaped for
      // the single-delta case.
      return reply.send({
        deltaId: `import-${Date.now()}`,
        deltas: batch.deltas,
        summary: {
          classes: model.classes.length,
          associations: model.associations.length,
          generalizations: model.generalizations.length,
          realizations: model.realizations.length,
          dependencies: model.dependencies.length,
          naryAssociations: model.naryAssociations.length,
        },
      });
    }
  );
}