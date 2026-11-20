import {expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {checkSortingAssemblySource} from './sorting-assembly-source-check.js';

const sourceBatch='11111111-1111-4111-8111-111111111111';
const targetBatch='22222222-2222-4222-8222-222222222222';
const submission='33333333-3333-4333-8333-333333333333';
const receipt='44444444-4444-4444-8444-444444444444';
const material='55555555-5555-4555-8555-555555555555';
const recipient='66666666-6666-4666-8666-666666666666';
const actor={id:'77777777-7777-4777-8777-777777777777',organization_id:'88888888-8888-4888-8888-888888888888',role:'chief'};
const q={submissionId:submission,grade:'A',assemblyBatchId:targetBatch,assemblyStepNumber:6,recipientId:recipient};

type Overrides={
 missingGrade?:boolean;missingReceipt?:boolean;unconfirmedSource?:boolean;
 wrongRoute?:boolean;recipientInactive?:boolean;claimed?:boolean;inactiveMaterial?:boolean;
 invalidCount?:boolean;targetStatus?:string;
};
function fixture(overrides:Overrides={}){
 const calls:string[]=[];
 const client={
  async query(query:string,values?:unknown[]){
   const sql=query.replace(/\s+/g,' ').trim();
   calls.push(sql);
   const yes=(rows:unknown[])=>({rows,rowCount:rows.length});
   if(sql.includes('FROM inventory_output_lines l')){
    return yes(overrides.missingGrade?[]:[{grade:'A',material_id:material,
     quantity:overrides.invalidCount?'0':'2',
     production_batch_id:sourceBatch,step_number:5,
     source_cut_id:overrides.unconfirmedSource?'local-cut':'received:'+receipt,
     cutting_receipt_id:overrides.unconfirmedSource?null:receipt,input_count:'3'}]);
   }
   if(sql.includes('FROM production_batches b JOIN production_orders o')){
    const isSource=values?.[1]===sourceBatch;
    return yes([{id:isSource?sourceBatch:targetBatch,stage:isSource?'sorting':'assembly',
     status:isSource?'completed':overrides.targetStatus??'in_progress',
     order_status:'released',workshop_id:isSource?'sorting-room':'assembly-room'}]);
   }
   if(sql.includes('FROM inventory_room_handoff_events e'))
    return yes(overrides.missingReceipt?[]:[{operation_id:receipt}]);
   if(sql.includes('FROM users u JOIN user_workshop_memberships m'))
    return yes(overrides.recipientInactive?[]:[{id:recipient}]);
   if(sql.includes('FROM production_batches s'))
    return yes(overrides.wrongRoute?[]:[{'?column?':1}]);
   if(sql.includes('FROM inventory_materials'))
    return yes(overrides.inactiveMaterial?[]:[{id:material}]);
   if(sql.includes('SELECT EXISTS('))
    return yes([{occupied:Boolean(overrides.claimed)}]);
   throw Error('Unexpected SQL: '+sql);
  },
 } as unknown as PoolClient;
 return{client,calls};
}
it('verifies the persisted single grade, confirmed physical receipt, route and recipient without writing',async()=>{
 const {client,calls}=fixture();
 const result=await checkSortingAssemblySource(client,actor,q);
 expect(result).toMatchObject({eligible:true,submissionId:submission,grade:'A',quantity:2,
  unit:'pieces',sourceBatchId:sourceBatch,assemblyBatchId:targetBatch,
  recipientId:recipient,reservationEffect:'none'});
 expect(calls.every(s=>s.startsWith('SELECT '))).toBe(true);
 expect(calls.some(s=>s.includes("e.kind='receive'"))).toBe(true);
 expect(calls.some(s=>s.includes('t.order_id=s.order_id'))).toBe(true);
});

it.each([
 ['nonexistent grade',{missingGrade:true},'sorting_output_grade_not_found'],
 ['missing confirmed physical receipt',{missingReceipt:true},'cutting_receipt_source_unavailable'],
 ['locally invented source',{unconfirmedSource:true},'confirmed_cutting_receipt_required'],
 ['wrong approved route/order',{wrongRoute:true},'sorting_assembly_route_mismatch'],
 ['inactive recipient',{recipientInactive:true},'assembly_route_or_receiver_required'],
 ['stock or other handoff already claims grade',{claimed:true},'sorting_grade_already_claimed'],
 ['inactive electrode material',{inactiveMaterial:true},'electrode_material_required'],
 ['nonpositive quantity',{invalidCount:true},'sorting_grade_quantity_invalid'],
 ['inactive target',{targetStatus:'completed'},'assembly_route_or_receiver_required'],
] as const)('rejects %s',async(_label,flags,message)=>{
 const {client,calls}=fixture(flags);
 await expect(checkSortingAssemblySource(client,actor,q)).rejects.toThrow(message);
 expect(calls.every(s=>s.startsWith('SELECT '))).toBe(true);
});

it('rejects unprivileged actors before reading source data',async()=>{
 const {client,calls}=fixture();
 await expect(checkSortingAssemblySource(client,{...actor,role:'operator'},q)).rejects.toThrow('sorting_supervisor_required');
 expect(calls).toHaveLength(0);
});
