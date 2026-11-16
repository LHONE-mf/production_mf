import type {FastifyInstance} from 'fastify';
import type {Pool} from 'pg';
import {z} from 'zod';
import {issueTransaction, issueBatchStep, issueMembership, issueFail} from './inventory-issue-scope.js';
import {
  custodySource,
  custodyLot,
  coatingSuccessor,
  custodyEligible,
  custodyDuplicate,
  custodyFailure,
} from './room-custody-scope.js';
import {registerRoomCustodyReads} from './room-custody-reads.js';
const uuid = z.guid(),
  quantity = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  zeroQuantity = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  step = quantity.max(2147483647),
  text = z
    .string()
    .min(1)
    .max(2000)
    .refine((v) => !!v.trim());
const common = z.object({operationId: uuid, deviceId: uuid, reason: text, evidence: text});
const declaration = common
  .extend({
    consumptionId: uuid,
    outputs: z
      .array(z.object({id: uuid, materialId: uuid, quantity}).strict())
      .min(1)
      .max(100),
    scrapMg: zeroQuantity,
    measuredLossMg: zeroQuantity,
    unknownMg: zeroQuantity,
    basis: z.literal('weighed-slurry-mass'),
    specificationReference: text,
    observedAt: z.number().finite().positive(),
  })
  .strict();
const offer = common
  .extend({
    outputLotId: uuid,
    quantity,
    expectedSourceRevision: quantity.max(Number.MAX_SAFE_INTEGER - 1),
    recipientId: uuid,
    destinationStepNumber: step,
  })
  .strict();
const receiptCommon = common.extend({handoffId: uuid});
const receipt = z.discriminatedUnion('kind', [
  receiptCommon.extend({kind: z.literal('receive'), observedQuantity: quantity}).strict(),
  receiptCommon.extend({kind: z.literal('discrepancy'), observedQuantity: zeroQuantity.nullable()}).strict(),
]);
export function registerRoomCustodyRoutes(app: FastifyInstance, pool: Pool) {
  registerRoomCustodyReads(app, pool);
  app.post('/inventory/room-outputs/slurry', async (request, reply) => {
    const parsed = declaration.safeParse(request.body);
    if (!parsed.success || new Set(parsed.data.outputs.map((o) => o.id)).size !== parsed.data.outputs.length)
      return reply.code(400).send({error: 'invalid_measured_output'});
    const data = parsed.data;
    try {
      const result = await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers['x-device-proof'],
        data.deviceId,
        true,
        request.headers['x-inventory-epoch'],
        async (client, actor, _level, epoch) => {
          const source = await custodySource(client, actor, data.consumptionId);
          const previous = await custodyDuplicate(
            client,
            actor,
            'inventory_room_outputs',
            data,
            data,
            'declaration',
          );
          if (previous) return previous;
          await custodySource(client, actor, data.consumptionId, true);
          await custodyEligible(client, actor.organization_id, data.consumptionId);
          const total = (source.request_payload.source.components as {actualMg: number}[]).reduce(
            (n, c) => n + BigInt(c.actualMg),
            0n,
          );
          if (
            total > BigInt(Number.MAX_SAFE_INTEGER) ||
            data.outputs.reduce((n, o) => n + BigInt(o.quantity), 0n) +
              BigInt(data.scrapMg) +
              BigInt(data.measuredLossMg) +
              BigInt(data.unknownMg) !==
              total
          )
            issueFail(409, 'measured_slurry_mass_balance_required');
          for (const output of data.outputs)
            if (
              !(
                await client.query(
                  "SELECT id FROM inventory_materials WHERE organization_id=$1 AND id=$2 AND active AND base_unit='mg' FOR SHARE",
                  [actor.organization_id, output.materialId],
                )
              ).rowCount
            )
              issueFail(409, 'approved_mass_material_required');
          const recordedAt = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
          const output = {
            ...data,
            productionBatchId: source.production_batch_id,
            stepNumber: source.step_number,
            inputQuantity: Number(total),
            source: source.snapshot,
            actorId: actor.id,
            recordedAt,
            qualityStatus: 'unreviewed',
            warehouseEffect: 'none',
          };
          await client.query(
            `INSERT INTO inventory_room_outputs(operation_id,organization_id,actor_id,device_id,consumption_id,production_batch_id,step_number,room_id,input_quantity,source_snapshot,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,'slurry',$8,$9,$10,$11,$12,$13)`,
            [
              data.operationId,
              actor.organization_id,
              actor.id,
              data.deviceId,
              data.consumptionId,
              source.production_batch_id,
              source.step_number,
              Number(total),
              JSON.stringify(source.snapshot),
              epoch,
              JSON.stringify(data),
              JSON.stringify(output),
              recordedAt,
            ],
          );
          for (const lot of data.outputs)
            await client.query(
              "INSERT INTO inventory_room_output_lots(id,organization_id,declaration_id,material_id,quantity,unit) VALUES($1,$2,$3,$4,$5,'mg')",
              [lot.id, actor.organization_id, data.operationId, lot.materialId, lot.quantity],
            );
          return {status: 'confirmed', operationId: data.operationId, declaration: output};
        },
      );
      return reply.code(result.status === 'duplicate' ? 200 : 201).send(result);
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.post('/inventory/room-handoffs', async (request, reply) => {
    const parsed = offer.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error: 'invalid_room_handoff'});
    const data = parsed.data;
    try {
      const result = await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers['x-device-proof'],
        data.deviceId,
        true,
        request.headers['x-inventory-epoch'],
        async (client, actor, _level, epoch) => {
          const lot = await custodyLot(client, actor, data.outputLotId);
          const previous = await custodyDuplicate(
            client,
            actor,
            'inventory_room_handoffs',
            data,
            data,
            'handoff',
          );
          if (previous) return previous;
          await custodyLot(client, actor, data.outputLotId, true);
          await custodyEligible(client, actor.organization_id, lot.consumption_id);
          const target = await coatingSuccessor(
            client,
            actor.organization_id,
            lot.production_batch_id,
            lot.step_number,
          );
          if (
            target.step_number !== data.destinationStepNumber ||
            !(await issueMembership(client, actor.organization_id, data.recipientId, target.workshop_id))
          )
            issueFail(409, 'room_handoff_route_or_recipient_required');
          const held = (
            await client.query(
              'SELECT count(*)::text AS n,COALESCE(sum(quantity::numeric),0)::text AS held FROM inventory_room_handoffs WHERE organization_id=$1 AND output_lot_id=$2',
              [actor.organization_id, lot.id],
            )
          ).rows[0];
          if (
            BigInt(data.expectedSourceRevision) !== BigInt(held.n) + 1n ||
            BigInt(data.quantity) > BigInt(lot.quantity) - BigInt(held.held)
          )
            issueFail(409, 'room_output_remaining_changed');
          const recordedAt = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
          const handoff = {
            ...data,
            productionBatchId: lot.production_batch_id,
            sourceRoom: 'slurry',
            destinationRoom: 'coating',
            recipientWorkshopId: target.workshop_id,
            sourceSnapshot: lot.snapshot,
            actorId: actor.id,
            recordedAt,
            unit: 'mg',
            warehouseEffect: 'none',
          };
          await client.query(
            `INSERT INTO inventory_room_handoffs(operation_id,organization_id,output_lot_id,actor_id,device_id,production_batch_id,destination_step,recipient_id,recipient_workshop_id,quantity,expected_revision,output_snapshot,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
              data.operationId,
              actor.organization_id,
              lot.id,
              actor.id,
              data.deviceId,
              lot.production_batch_id,
              target.step_number,
              data.recipientId,
              target.workshop_id,
              data.quantity,
              data.expectedSourceRevision,
              JSON.stringify(lot.snapshot),
              epoch,
              JSON.stringify(data),
              JSON.stringify(handoff),
              recordedAt,
            ],
          );
          return {status: 'confirmed', operationId: data.operationId, handoff};
        },
      );
      return reply.code(result.status === 'duplicate' ? 200 : 201).send(result);
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
  app.post('/inventory/room-handoffs/acknowledgements', async (request, reply) => {
    const parsed = receipt.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({error: 'invalid_room_receipt'});
    const data = parsed.data;
    try {
      const result = await issueTransaction(
        pool,
        request.headers.authorization,
        request.headers['x-device-proof'],
        data.deviceId,
        true,
        request.headers['x-inventory-epoch'],
        async (client, actor, _level, epoch) => {
          const handoff = (
            await client.query(
              'SELECT * FROM inventory_room_handoffs WHERE organization_id=$1 AND operation_id=$2 FOR UPDATE',
              [actor.organization_id, data.handoffId],
            )
          ).rows[0];
          if (!handoff) issueFail(404, 'room_handoff_not_found');
          if (
            handoff.recipient_id !== actor.id ||
            !(await issueMembership(client, actor.organization_id, actor.id, handoff.recipient_workshop_id))
          )
            issueFail(403, 'assigned_room_receiver_required');
          await issueBatchStep(
            client,
            actor,
            handoff.production_batch_id,
            handoff.destination_step,
            false,
            false,
          );
          const previous = await custodyDuplicate(
            client,
            actor,
            'inventory_room_handoff_events',
            data,
            data,
            'receipt',
          );
          if (previous) return previous;
          if (data.kind === 'receive')
            await issueBatchStep(client, actor, handoff.production_batch_id, handoff.destination_step, false);
          if (
            (
              await client.query(
                "SELECT 1 FROM inventory_room_handoff_events WHERE organization_id=$1 AND handoff_id=$2 AND kind='receive'",
                [actor.organization_id, handoff.operation_id],
              )
            ).rowCount
          )
            issueFail(409, 'room_handoff_already_received');
          if (data.kind === 'receive') {
            if (BigInt(data.observedQuantity) !== BigInt(handoff.quantity))
              issueFail(409, 'handoff_quantity_mismatch');
            await custodyEligible(client, actor.organization_id, handoff.output_snapshot.consumptionId);
          }
          const recordedAt = (await client.query('SELECT clock_timestamp() AS at')).rows[0].at.toISOString();
          const receipt = {
            ...data,
            sourceSnapshot: handoff.result_payload,
            actorId: actor.id,
            recordedAt,
            custodyEffect: data.kind === 'receive' ? 'received' : 'none',
            unit: 'mg',
            warehouseEffect: 'none',
          };
          await client.query(
            'INSERT INTO inventory_room_handoff_events(operation_id,organization_id,handoff_id,actor_id,device_id,kind,observed_quantity,epoch,request_payload,result_payload,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
            [
              data.operationId,
              actor.organization_id,
              handoff.operation_id,
              actor.id,
              data.deviceId,
              data.kind,
              data.observedQuantity,
              epoch,
              JSON.stringify(data),
              JSON.stringify(receipt),
              recordedAt,
            ],
          );
          return {status: 'confirmed', operationId: data.operationId, receipt};
        },
      );
      return reply.code(result.status === 'duplicate' ? 200 : 201).send(result);
    } catch (error) {
      const e = custodyFailure(error);
      return reply.code(e.status).send(e.body);
    }
  });
}
