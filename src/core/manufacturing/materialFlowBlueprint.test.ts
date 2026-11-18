import {describe,expect,it} from 'vitest';
import {StageId} from '../types';
import {
  APPROVED_ALLOCATION_POLICY, CELL_FORMAT_PLANS, DEFAULT_DIRECT_HANDOFFS, MATERIAL_FLOW_BLUEPRINT,
  POLYIMIDE_APPLICATIONS, PROPOSED_MANUFACTURING_OPERATIONS, WIP_RELEASE_HANDOFFS,
} from './materialFlowBlueprint';

describe('approved material flow blueprint (advisory only)',()=>{
  it('covers every existing app room without creating new room identities',()=>{
    expect(Object.keys(MATERIAL_FLOW_BLUEPRINT).sort()).toEqual(Object.values(StageId).sort());
  });

  it('models direct handoffs without confusing Assembly WIP buffers with direct outputs',()=>{
    for(const link of DEFAULT_DIRECT_HANDOFFS){
      const handling=link.from===StageId.ASSEMBLY?'room-wip':'direct';
      expect(MATERIAL_FLOW_BLUEPRINT[link.from].outputs.some(item=>item.material===link.material&&item.handling===handling)).toBe(true);
      expect(MATERIAL_FLOW_BLUEPRINT[link.to].upstreamInputs).toContain(link.material);
    }
    expect(MATERIAL_FLOW_BLUEPRINT[StageId.SORTING].outputs).toContainEqual({material:'sorted-electrodes',handling:'direct'});
  });

  it('keeps Assembly intermediates and Formation outputs in room WIP rather than posting warehouse stock',()=>{
    const assembly=MATERIAL_FLOW_BLUEPRINT[StageId.ASSEMBLY];
    for(const material of ['lithium-electrodes','electrode-stacks','wound-blocks','assembled-dry-cells'])
      expect(assembly.outputs).toContainEqual({material,handling:'room-wip'});
    expect(MATERIAL_FLOW_BLUEPRINT[StageId.FORMATION].outputs).toContainEqual({material:'formed-cells',handling:'room-wip'});
    expect(MATERIAL_FLOW_BLUEPRINT[StageId.STORAGE].outputs).toEqual([]);
  });

  it('allows polyimide tape from Storage to serve the three distinct user-approved applications',()=>{
    const uses=POLYIMIDE_APPLICATIONS.map(x=>x.application).sort();
    expect(uses).toEqual(['coating-lip-sealing','jelly-roll-taping','tab-insulation']);
    for(const point of POLYIMIDE_APPLICATIONS)
      expect(MATERIAL_FLOW_BLUEPRINT[point.room].warehouseIssueCandidates).toContain('polyimide-tape');
  });

  it('models both existing Filling rooms and two distinct paths to Formation',()=>{
    const links=[...DEFAULT_DIRECT_HANDOFFS,...WIP_RELEASE_HANDOFFS];
    expect(links).toContainEqual({from:StageId.ASSEMBLY,to:StageId.ELECTROLYTE,material:'assembled-dry-cells'});
    expect(links).toContainEqual({from:StageId.ASSEMBLY,to:StageId.ELECTROLYTE_705,material:'assembled-dry-cells'});
    expect(links).toContainEqual({from:StageId.ELECTROLYTE,to:StageId.FORMATION,material:'filled-cells'});
    expect(links).toContainEqual({from:StageId.ELECTROLYTE_705,to:StageId.WALZING,material:'filled-cells'});
    expect(links).toContainEqual({from:StageId.WALZING,to:StageId.FORMATION,material:'walzed-cells'});
  });

  it('includes pouch as a planned target, not as an already-supported Assembly format',()=>{
    expect(CELL_FORMAT_PLANS).toContainEqual({format:'pouch',state:'planned'});
    expect(CELL_FORMAT_PLANS).toContainEqual({format:'cylindrical',state:'existing'});
    expect(CELL_FORMAT_PLANS).toContainEqual({format:'prismatic',state:'existing'});
  });
  it('keeps partial/multiple-lot sourcing approved but all stock effects disabled',()=>{
    expect(APPROVED_ALLOCATION_POLICY).toMatchObject({
      partialQuantitiesAllowed:true,
      multipleSourceLotsAllowed:true,
      explicitOriginalSourceRequired:true,
      blueprintCreatesStock:false,
      blueprintConsumesStock:false,
      directHandoffPostsWarehouseReceipt:false,
    });
  });

  it('has no inferred warehouse receipt for any normal direct or WIP output',()=>{
    for(const room of Object.values(MATERIAL_FLOW_BLUEPRINT)){
      for(const output of room.outputs)
        expect(['direct','room-wip']).toContain(output.handling);
    }
    expect(MATERIAL_FLOW_BLUEPRINT[StageId.STORAGE].outputs).toEqual([]);
  });

  it('keeps additional operations as proposals, not enabled production rooms',()=>{
    const names=PROPOSED_MANUFACTURING_OPERATIONS.map(operation=>operation.id);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('electrode-vacuum-drying');
    expect(names).toContain('pouch-cell-packing-and-primary-seal');
    expect(names).toContain('pouch-degassing-and-final-seal');
    expect(names).toContain('post-formation-aging');
    expect(names).toContain('final-capacity-resistance-and-safety-testing');
    expect(PROPOSED_MANUFACTURING_OPERATIONS.every(op=>op.status==='proposed')).toBe(true);
    expect(PROPOSED_MANUFACTURING_OPERATIONS.every(op=>Object.values(StageId).includes(op.candidateRoom))).toBe(true);
  });
});
