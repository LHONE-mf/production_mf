import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { z } from 'zod';
import { authenticate } from './auth.js';

const stage = z.enum([
  'storage', 'slurry', 'coating', 'calendaring', 'cutting', 'sorting',
  'assembly', 'electrolyte', 'electrolyte-705', 'walzing', 'formation',
]);
const routeSchema = z.object({
  code: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(300),
  steps: z.array(z.object({
    name: z.string().trim().min(1).max(300),
    stage,
    workshopId: z.string().trim().min(1).max(120),
    electrodeLine: z.enum(['cathode', 'anode', 'common']),
  }).strict()).min(1).max(50),
}).strict();
const approvalParams = z.object({
  id: z.string().uuid(),
  version: z.coerce.number().int().positive().safe(),
}).strict();
const orderSchema = z.object({
  orderCode: z.string().trim().min(1).max(80),
  productCode: z.string().trim().min(1).max(120),
  routeId: z.string().uuid(),
  routeVersion: z.number().int().positive().safe(),
  // Keep decimal quantities exact from the API through PostgreSQL NUMERIC.
  plannedQuantity: z.string().regex(/^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/),
  quantityUnit: z.enum(['cells', 'pieces', 'kg', 'm', 'm2']),
}).strict();

function postgresCode(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code : null;
}

/**
 * M2 planning pilot: no stage execution or automatic task synchronization.
 * Route and order writes require real server authentication. Until workshop
 * scoped order permissions are designed, only chiefs may create orders.
 */
export function registerPlanningRoutes(app: FastifyInstance, pool: Pool) {
  app.post('/planning/routes', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief' && actor.role !== 'technologist') {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const parsed = routeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_route' });
    const id = randomUUID(), { code, name, steps } = parsed.data;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO process_routes
        (organization_id,id,code,name,created_by) VALUES($1,$2,$3,$4,$5)`,
        [actor.organization_id,id,code,name,actor.id]);
      await client.query(`INSERT INTO process_route_versions
        (organization_id,route_id,version) VALUES($1,$2,1)`,
        [actor.organization_id,id]);
      for (const [index, step] of steps.entries()) {
        await client.query(`INSERT INTO process_route_steps
          (organization_id,route_id,route_version,step_number,name,stage,workshop_id,electrode_line)
          VALUES($1,$2,1,$3,$4,$5,$6,$7)`,
          [actor.organization_id,id,index+1,step.name,step.stage,step.workshopId,step.electrodeLine]);
      }
      await client.query('COMMIT');
      return reply.code(201).send({ id, code, name, version: 1, state: 'draft', steps: steps.length });
    } catch (error) {
      await client.query('ROLLBACK');
      if (postgresCode(error) === '23505') return reply.code(409).send({ error: 'route_code_exists' });
      if (postgresCode(error) === '23503') return reply.code(400).send({ error: 'unknown_route_workshop' });
      throw error;
    } finally {
      client.release();
    }
  });

  app.post('/planning/routes/:id/versions/:version/approve', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const params = approvalParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_route_version' });
    const { id, version } = params.data;
    const result = await pool.query(`UPDATE process_route_versions v
      SET state='approved', approved_at=now(), approved_by=$4
      WHERE v.organization_id=$1 AND v.route_id=$2 AND v.version=$3
        AND v.state='draft'
        AND EXISTS (
          SELECT 1 FROM process_route_steps s
          WHERE s.organization_id=v.organization_id
            AND s.route_id=v.route_id AND s.route_version=v.version
        )
      RETURNING v.route_id, v.version, v.state`,
      [actor.organization_id,id,version,actor.id]);
    if (!result.rowCount) return reply.code(409).send({ error: 'route_not_draft_or_empty' });
    return { id, version, state: 'approved' };
  });

  app.get('/planning/routes', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (!['chief','master','technologist'].includes(actor.role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const result = await pool.query(`SELECT r.id,r.code,r.name,v.version,v.state,
        (SELECT count(*)::int FROM process_route_steps s
          WHERE s.organization_id=v.organization_id AND s.route_id=v.route_id
            AND s.route_version=v.version) AS step_count
      FROM process_routes r
      JOIN process_route_versions v
        ON v.organization_id=r.organization_id AND v.route_id=r.id
      WHERE r.organization_id=$1 AND ($2::boolean OR v.state='approved')
      ORDER BY r.code,v.version DESC LIMIT 500`,
      [actor.organization_id,actor.role !== 'master']);
    return { routes: result.rows.map(row => ({
      id: row.id, code: row.code, name: row.name, version: row.version,
      state: row.state, stepCount: row.step_count,
    })) };
  });

  app.post('/planning/orders', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const parsed = orderSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_order' });
    const data = parsed.data, id = randomUUID();
    try {
      const result = await pool.query(`INSERT INTO production_orders
        (organization_id,id,order_code,product_code,route_id,route_version,
          planned_quantity,quantity_unit,created_by)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
        FROM process_route_versions v
        WHERE v.organization_id=$1 AND v.route_id=$5 AND v.version=$6 AND v.state='approved'
        RETURNING id,order_code,product_code,route_id,route_version,
          status,planned_quantity::text,quantity_unit`,
        [actor.organization_id,id,data.orderCode,data.productCode,data.routeId,
          data.routeVersion,data.plannedQuantity,data.quantityUnit,actor.id]);
      if (!result.rowCount) return reply.code(409).send({ error: 'route_not_approved' });
      const row = result.rows[0];
      return reply.code(201).send({ id: row.id, orderCode: row.order_code,
        productCode: row.product_code, routeId: row.route_id,
        routeVersion: row.route_version, status: row.status,
        plannedQuantity: row.planned_quantity, quantityUnit: row.quantity_unit });
    } catch (error) {
      if (postgresCode(error) === '23505') return reply.code(409).send({ error: 'order_code_exists' });
      throw error;
    }
  });

  app.get('/planning/orders', async (request, reply) => {
    const actor = await authenticate(pool, request.headers.authorization);
    if (!actor) return reply.code(401).send({ error: 'unauthorized' });
    // No workshop-scoped order reads yet. Fail closed for non-chiefs.
    if (actor.role !== 'chief') return reply.code(403).send({ error: 'forbidden' });
    const result = await pool.query(`SELECT id,order_code,product_code,route_id,route_version,
        status,planned_quantity::text,quantity_unit
      FROM production_orders WHERE organization_id=$1
      ORDER BY created_at DESC,id DESC LIMIT 500`,[actor.organization_id]);
    return { orders: result.rows.map(row => ({
      id: row.id, orderCode: row.order_code, productCode: row.product_code,
      routeId: row.route_id, routeVersion: row.route_version, status: row.status,
      plannedQuantity: row.planned_quantity, quantityUnit: row.quantity_unit,
    })) };
  });
}
