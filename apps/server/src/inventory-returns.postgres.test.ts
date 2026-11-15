import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInventoryHandoffFixture } from './inventory-test-fixture.js';
const integration = process.env.POSTGRES_TEST_URL ? describe : describe.skip;
integration('Unused issue returns and accountable scrap (real PostgreSQL)', () => {
  let f: Awaited<ReturnType<typeof createInventoryHandoffFixture>>;
  beforeAll(async () => { f = await createInventoryHandoffFixture(); });
  afterAll(async () => { if (f) { await f.app.close(); await f.pool.end(); } });
  async function received(expiresOn?:string) {
    const { id, issue } = await f.reserved(500,expiresOn);
    for (const [kind, revision] of [['approve', 2], ['dispatch', 3]] as const) {
      const response = await f.act(issue.id, f.operation(kind, revision, 1, { expectedStockRevision: 3 })); expect(response.statusCode, response.body).toBe(201);
    }
    const receipt = await f.act(issue.id, f.operation('receive', 4, 4), 4); expect(receipt.statusCode, receipt.body).toBe(201); return { stockId: id, issue: receipt.json().issue };
  }
  const body = (issueId: string, sourceStockId: string, quantity = 200, i = 2) => ({ operationId: randomUUID(), deviceId: f.actors[i].device, kind: 'return', issueId, productionBatchId: f.batch, sourceStockId, expectedSettlementRevision: 1, expectedSourceRevision: 4, stockId: randomUUID(), locationId: f.location, quantity, condition: 'untouched_unused', reason: 'Unused original material physically received', evidence: 'CI package/condition verification #42' });
  const send = (data: ReturnType<typeof body> | Record<string, unknown>, i = 2) => f.post('/inventory/issues/' + data.issueId + '/outcomes', data, i);
  it('receives a traceable unused return directly AVAILABLE, with a new package identity and no second Chief QA', async () => {
    const source = await received(), request = body(source.issue.id, source.stockId);
    const result = await send(request); expect(result.statusCode, result.body).toBe(201);
    expect(result.json()).toMatchObject({ status: 'confirmed', operationId: request.operationId, settlement: { revision: 2, issued: 500, returned: 200, scrapped: 0, consumed: 0, outstanding: 300 }, stock: { stockId: request.stockId, materialId: f.material, manufacturerLot: 'SAME-MAKER-LOT', quality: 'released', disposition: 'release', onHand: 200, reserved: 0, available: 200, revision: 1 } });
    expect((await send(request)).statusCode).toBe(200); expect((await send(request)).json().stock).toEqual(result.json().stock);
    expect((await send({ ...request, quantity: 201 })).statusCode).toBe(409);
    expect((await f.pool.query('SELECT on_hand::int,reserved::int,revision FROM inventory_stocks WHERE id=$1', [source.stockId])).rows[0]).toEqual({ on_hand: 500, reserved: 0, revision: 4 });
    expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_quality_dispositions WHERE stock_id=$1', [request.stockId])).rows[0].n).toBe(0);
    expect((await f.pool.query('SELECT source_stock_id,production_batch_id,return_stock_id FROM inventory_issue_outcomes WHERE operation_id=$1', [request.operationId])).rows[0]).toEqual({ source_stock_id: source.stockId, production_batch_id: f.batch, return_stock_id: request.stockId });
    await expect(f.pool.query("UPDATE inventory_issue_outcomes SET evidence='rewrite' WHERE operation_id=$1", [request.operationId])).rejects.toThrow('immutable');
    const next=await f.request(100),reserved=await f.act(next.issue.id,f.operation('reserve',1,1,{stockId:request.stockId,expectedStockRevision:1}));expect(reserved.statusCode,reserved.body).toBe(201);expect(reserved.json().stock).toMatchObject({quality:'released',reserved:100,onHand:200});
    expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_quality_dispositions WHERE stock_id=$1',[request.stockId])).rows[0].n).toBe(0);
    expect((await send(request)).json().stock.revision).toBe(1); // Exact ACK remains its original result after later stock use.
  });
  it('caps partial and competing returns at outstanding issued quantity, not current warehouse quantity', async () => {
    const source = await received(), a = body(source.issue.id, source.stockId, 300), b = body(source.issue.id, source.stockId, 300, 0);
    const results = await Promise.all([send(a), send(b, 0)]); expect(results.map(r => r.statusCode).sort()).toEqual([201, 409]);
    expect((await send({ ...body(source.issue.id, source.stockId, 201), expectedSettlementRevision: 2 })).statusCode).toBe(409);
    const final = await send({ ...body(source.issue.id, source.stockId, 200), expectedSettlementRevision: 2 }); expect(final.statusCode, final.body).toBe(201); expect(final.json().settlement.outstanding).toBe(0);
    expect((await send({ ...body(source.issue.id, source.stockId, 1), expectedSettlementRevision: 3 })).statusCode).toBe(409);
  });
  it('rejects unreceived, wrong-source/batch and unsafe-condition returns without creating stock', async () => {
    const unreceived = await f.reserved(); expect((await send(body(unreceived.issue.id, unreceived.id))).statusCode).toBe(409);
    const source = await received();
    for (const patch of [{ sourceStockId: randomUUID() }, { productionBatchId: randomUUID() }, { condition: 'damaged' }, { condition: 'contaminated' }, { condition: 'altered' }, { condition: 'untraceable' }]) {
      const request = { ...body(source.issue.id, source.stockId), ...patch }; expect((await send(request)).statusCode).toBe(409); expect((await f.pool.query('SELECT 1 FROM inventory_stocks WHERE id=$1', [request.stockId])).rowCount).toBe(0);
    }
    expect((await send({ ...body(source.issue.id, source.stockId), quantity: 0.5 })).statusCode).toBe(400);
    for (const i of [3, 4, 5]) expect((await send(body(source.issue.id, source.stockId, 1, i), i)).statusCode).toBe(403);
  });
  it('never bypasses current Chief holds/expiry and propagates source eligibility to returned package use', async () => {
    const source = await received(), request = body(source.issue.id, source.stockId), returned = await send(request); expect(returned.statusCode, returned.body).toBe(201);
    const hold = await f.post('/inventory/stocks/' + source.stockId + '/quality-dispositions', { operationId: randomUUID(), stockId: source.stockId, deviceId: f.actors[0].device, expectedRevision: 4, disposition: 'hold', reason: 'Subsequent Chief source hold', evidence: 'CI source hold' }); expect(hold.statusCode, hold.body).toBe(201);
    expect((await f.post('/inventory/stocks/'+request.stockId+'/quality-dispositions',{operationId:randomUUID(),stockId:request.stockId,deviceId:f.actors[0].device,expectedRevision:1,disposition:'release',reason:'Cannot override source hold on descendant',evidence:'Source must be resolved first'})).json().error).toBe('source_quality_held');
    expect((await send({ ...body(source.issue.id, source.stockId), expectedSettlementRevision: 2, expectedSourceRevision: 5 })).statusCode).toBe(409);
    const req = await f.request(100); const reserve = await f.act(req.issue.id, f.operation('reserve', 1, 1, { stockId: request.stockId, expectedStockRevision: 1 })); expect(reserve.statusCode, reserve.body).toBe(409);
    expect((await f.post('/inventory/stocks/' + request.stockId + '/operations', { operationId: randomUUID(), deviceId: f.actors[1].device, kind: 'reserve', reservationId: randomUUID(), productionBatchId: f.batch, expectedRevision: 1, quantity: 1, reason: 'Cannot bypass inherited source hold' }, 1)).statusCode).toBe(409);
    const expired = await received(); await f.pool.query("UPDATE inventory_stocks SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.stockId]); expect((await send(body(expired.issue.id, expired.stockId))).statusCode).toBe(409);
  });
  it('records privileged scrap against issued ownership without debiting warehouse again or returning scrap to AVAILABLE', async () => {
    const source = await received();
    const scrap = { operationId: randomUUID(), deviceId: f.actors[1].device, kind: 'scrap', issueId: source.issue.id, productionBatchId: f.batch, sourceStockId: source.stockId, expectedSettlementRevision: 1, quantity: 100, reason: 'Damaged unused issued material disposed under Manager authority', evidence: 'CI witnessed disposal report' };
    expect((await send({ ...scrap, deviceId: f.actors[2].device })).statusCode).toBe(403);
    const accepted = await send(scrap, 1); expect(accepted.statusCode, accepted.body).toBe(201); expect(accepted.json().stock).toBeUndefined(); expect(accepted.json().settlement).toMatchObject({ scrapped: 100, returned: 0, outstanding: 400 }); expect((await send(scrap, 1)).statusCode).toBe(200);
    expect((await send({ ...body(source.issue.id, source.stockId, 401), expectedSettlementRevision: 2 })).statusCode).toBe(409);
    expect((await f.pool.query('SELECT on_hand::int FROM inventory_stocks WHERE id=$1', [source.stockId])).rows[0].on_hand).toBe(500);
  });
  it('records warehouse scrap separately with evidence, current Manager authority and no consumption of reservations',async()=>{
    const {id,issue}=await f.reserved(),hold=await f.post('/inventory/stocks/'+id+'/quality-dispositions',{operationId:randomUUID(),stockId:id,deviceId:f.actors[0].device,expectedRevision:3,disposition:'hold',reason:'Warehouse material damaged',evidence:'CI hold report'});expect(hold.statusCode,hold.body).toBe(201);
    const request={operationId:randomUUID(),deviceId:f.actors[1].device,kind:'scrap',expectedRevision:4,quantity:100,reason:'Witnessed disposal of damaged warehouse stock',evidence:'Actual signed warehouse waste report'};
    expect((await f.post('/inventory/stocks/'+id+'/operations',{...request,deviceId:f.actors[2].device},2)).statusCode).toBe(403);
    expect((await f.post('/inventory/stocks/'+id+'/operations',{...request,operationId:randomUUID(),quantity:501},1)).statusCode).toBe(409);
    const result=await f.post('/inventory/stocks/'+id+'/operations',request,1);expect(result.statusCode,result.body).toBe(201);expect(result.json().stock).toMatchObject({onHand:900,reserved:500,available:400,quality:'blocked',revision:5});
    expect((await f.post('/inventory/stocks/'+id+'/operations',request,1)).json().stock).toEqual(result.json().stock);
    expect((await f.post('/inventory/stocks/'+id+'/operations',{...request,evidence:'Changed witness'},1)).statusCode).toBe(409);
    expect((await f.pool.query('SELECT kind,request_payload FROM inventory_operations WHERE operation_id=$1',[request.operationId])).rows[0]).toMatchObject({kind:'scrap',request_payload:{evidence:request.evidence}});
    expect((await f.pool.query('SELECT quantity::int FROM inventory_reservations WHERE issue_id=$1',[issue.id])).rows[0].quantity).toBe(500);
    expect((await f.pool.query('SELECT count(*)::int AS n FROM inventory_issue_outcomes WHERE issue_id=$1',[issue.id])).rows[0].n).toBe(0);
  });
  it('requires paired return provenance at the database boundary and never grants operator scrap authority',async()=>{
    const source=await received(),child=randomUUID(),client=await f.pool.connect();
    try{
      await client.query('BEGIN');
      await client.query("INSERT INTO inventory_stocks(id,organization_id,material_id,manufacturer_lot,location_id,quality,disposition,on_hand) VALUES($1,$2,$3,'SAME-MAKER-LOT',$4,'released','release',1)",[child,f.org,f.material,f.location]);
      await client.query("INSERT INTO inventory_operations(operation_id,organization_id,stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,reason,production_batch_id,request_payload,result_stock) VALUES($1,$2,$3,$4,$5,'return',1,0,1,'Unpaired counterfeit return',$6,'{}','{}')",[randomUUID(),f.org,child,f.actors[2].id,f.actors[2].device,f.batch]);
      await expect(client.query('COMMIT')).rejects.toThrow('inventory_return_pair_required');
    }finally{await client.query('ROLLBACK');client.release();}
    expect((await f.pool.query('SELECT 1 FROM inventory_stocks WHERE id=$1',[child])).rowCount).toBe(0);
    await expect(f.pool.query("INSERT INTO inventory_issue_outcomes(operation_id,organization_id,issue_id,production_batch_id,source_stock_id,actor_id,device_id,kind,quantity,expected_revision,resulting_revision,epoch,reason,evidence,request_payload,result_payload) VALUES($1,$2,$3,$4,$5,$6,$7,'scrap',1,1,2,$8,'Forbidden operator scrap','Must fail','{}','{}')",[randomUUID(),f.org,source.issue.id,f.batch,source.stockId,f.actors[2].id,f.actors[2].device,f.epoch])).rejects.toThrow('outcome_warehouse_authority_required');
  });
  it('denies another actual organization access to a received issue or its return stock',async()=>{
    const source=await received(),other=await createInventoryHandoffFixture();
    try{
      const request={...body(source.issue.id,source.stockId),deviceId:other.actors[2].device};
      expect((await other.post('/inventory/issues/'+source.issue.id+'/outcomes',request,2)).statusCode).toBe(404);
      expect((await other.get('/inventory/issues/'+source.issue.id+'/outcomes?deviceId='+other.actors[1].device,1)).statusCode).toBe(404);
      expect((await f.pool.query('SELECT 1 FROM inventory_stocks WHERE id=$1',[request.stockId])).rowCount).toBe(0);
    }finally{await other.app.close();await other.pool.end();}
  });
  it('inherits exact QA/lot/dates, accepts a later completed-batch return and provides scoped paginated history',async()=>{
    const source=await received('2099-12-31'),request=body(source.issue.id,source.stockId);
    await f.pool.query("UPDATE production_batches SET status='completed' WHERE organization_id=$1 AND id=$2",[f.org,f.batch]);
    try{const result=await send(request);expect(result.statusCode,result.body).toBe(201);expect(result.json().stock).toMatchObject({expiresAt:'2100-01-01T00:00:00.000Z',manufacturedOn:'2026-01-01'});}
    finally{await f.pool.query("UPDATE production_batches SET status='created' WHERE organization_id=$1 AND id=$2",[f.org,f.batch]);}
    const list=await f.get('/inventory/returns?deviceId='+f.actors[2].device,2);expect(list.statusCode,list.body).toBe(200);expect(list.json().items).toEqual(expect.arrayContaining([expect.objectContaining({issue:expect.objectContaining({id:source.issue.id}),settlement:expect.objectContaining({returned:200,outstanding:300}),sourceEligible:true})]));
    const history=await f.get('/inventory/issues/'+source.issue.id+'/outcomes?deviceId='+f.actors[4].device+'&limit=1',4);expect(history.statusCode,history.body).toBe(200);expect(history.json().items[0]).toMatchObject({actorId:f.actors[2].id,kind:'return',quantity:200,stockId:request.stockId});expect(JSON.stringify(history.json())).not.toContain('onHand');
    expect((await f.get('/inventory/returns?deviceId='+f.actors[4].device,4)).statusCode).toBe(403);
    expect((await f.get('/inventory/issues/'+source.issue.id+'/outcomes?deviceId='+f.actors[5].device,5)).statusCode).toBe(404);
    expect((await f.get('/inventory/returns?deviceId='+f.actors[2].device+'&limit=101',2)).statusCode).toBe(400);
  });
  it('rejects cross-ledger intent reuse, stale history and a revoked warehouse grant after the real lock wait',async()=>{
    const source=await received(),request=body(source.issue.id,source.stockId);
    const original=(await f.pool.query("SELECT operation_id FROM inventory_operations WHERE stock_id=$1 AND kind='receive'",[source.stockId])).rows[0].operation_id;
    expect((await send({...request,operationId:original})).json().error).toBe('operation_id_reused');
    try{await f.pool.query('UPDATE inventory_streams SET epoch=$2 WHERE organization_id=$1',[f.org,randomUUID()]);expect((await send(request)).json().error).toBe('inventory_epoch_changed');}
    finally{await f.pool.query('UPDATE inventory_streams SET epoch=$2 WHERE organization_id=$1',[f.org,f.epoch]);}
    const blocker=await f.pool.connect();let pending:Promise<Awaited<ReturnType<typeof send>>>|undefined;
    try{
      await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[f.org+':inventory-sequence']);await blocker.query('UPDATE inventory_access SET active=false WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[2].id]);pending=Promise.resolve(send(request));
      const deadline=Date.now()+4000;while(!(await f.pool.query("SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%pg_advisory_xact_lock(hashtextextended%' AND wait_event_type='Lock'",[f.applicationName])).rowCount){if(Date.now()>deadline)throw Error('Return did not wait for stock lock');await new Promise(r=>setTimeout(r,10));}
      await blocker.query('COMMIT');expect((await pending).statusCode).toBe(403);expect((await f.pool.query('SELECT 1 FROM inventory_stocks WHERE id=$1',[request.stockId])).rowCount).toBe(0);
    }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;await f.pool.query('UPDATE inventory_access SET active=true WHERE organization_id=$1 AND user_id=$2',[f.org,f.actors[2].id]);}
  },10000);
});
