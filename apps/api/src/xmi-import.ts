import type { FastifyInstance } from 'fastify';
import { parseXmiDocument, xmiToDeltaBatch } from '@app/adapters-import';
import { loadDiagramById, DiagramNotFoundError } from './index.js';
import { BatchDeltaSchema } from '@app/core';

export function registerXmiImportRoutes(app: FastifyInstance) {
  app.post<{ Params: { id: string }; Body: { xmi: string } }>(
    '/diagrams/:id/import/xmi',
    { schema: { body: { type: 'object', required: ['xmi'], properties: { xmi: { type: 'string' } } } } },
    async (request, reply) => {
      const diagramId = request.params.id;
      const { xmi } = request.body;

      // Check if diagram exists. loadDiagramById throws DiagramNotFoundError
      // for a missing row (it never returns null), so 404 must be derived
      // from the caught error — same pattern as POST /diagrams/:id/generate.
      try {
        await loadDiagramById(diagramId);
      } catch (error) {
        if (error instanceof DiagramNotFoundError) {
          return reply.status(404).send({ error: 'Diagram not found' });
        }
        return reply
          .status(500)
          .send({ error: error instanceof Error ? error.message : 'Diagram load failed' });
      }

      let model;
      try {
        model = parseXmiDocument(xmi);
      } catch (err: any) {
        return reply.status(400).send({ error: err.message || 'Invalid XMI' });
      }

      const batch = xmiToDeltaBatch(model, diagramId);

      // Validate the batch against the canonical schema before returning
      const validatedBatch = BatchDeltaSchema.parse(batch);

      return reply.send({
        deltaId: validatedBatch.id,
        batch: validatedBatch,
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