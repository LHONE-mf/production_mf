import {describe,expect,it} from 'vitest';
import {StageId} from '../types';
import {
  CELL_FORMAT_PLANS, DEFAULT_DIRECT_HANDOFFS, MATERIAL_FLOW_BLUEPRINT,
  POLYIMIDE_APPLICATIONS, WIP_RELEASE_HANDOFFS, CONDITIONAL_HANDOFFS, OPTIONAL_STORAGE_OUTPUTS, FLOW_MATERIAL_KINDS,
} from './materialFlowBlueprint';

describe('approved material flow blueprint (advisory only)',()=>{
  it('covers every existing app room without creating new room identities',()=>{
    expect(Object.keys(MATERIAL_FLOW_BLUEPRINT).sort()).toEqual(Object.values(StageId).sort());
  });

  it('keeps normal upstream transfers direct and conserves their material identities',()=>{
    for(const link of DEFAULT_DIRECT_HANDOFFS){
      expect(MATERIAL_FLOW_BLUEPRINT[link.from].outputs.some(item=>item.material===link.material&&item.handling==='direct')).toBe(true);
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
    expect(FLOW_MATERIAL_KINDS['polyimide-tape']).toBe('component');
    expect(FLOW_MATERIAL_KINDS['formed-cells']).toBe('work-in-process');
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

  it('releases Assembly WIP explicitly before a handoff without changing its initial custody',()=>{
    expect(WIP_RELEASE_HANDOFFS).toHaveLength(2);
    for(const link of WIP_RELEASE_HANDOFFS){
      expect(MATERIAL_FLOW_BLUEPRINT[link.from].outputs).toContainEqual({material:link.material,handling:'room-wip'});
      expect(MATERIAL_FLOW_BLUEPRINT[link.to].upstreamInputs).toContain(link.material);
    }
  });

  it('keeps bypass and full-known-serial route restrictions explicit and advisory',()=>{
    expect(CONDITIONAL_HANDOFFS).toContainEqual({from:StageId.COATING,to:StageId.CUTTING,material:'coated-roll',requires:['approved-calendaring-bypass']});
    expect(CONDITIONAL_HANDOFFS).toContainEqual({from:StageId.ELECTROLYTE_705,to:StageId.WALZING,material:'filled-cells',requires:['cylindrical','complete-known-filled-output','exact-source-serials']});
    expect(CONDITIONAL_HANDOFFS).toContainEqual({from:StageId.ELECTROLYTE,to:StageId.FORMATION,material:'filled-cells',requires:['complete-known-filled-output','exact-source-serials']});
    expect(CONDITIONAL_HANDOFFS).toContainEqual({from:StageId.WALZING,to:StageId.FORMATION,material:'walzed-cells',requires:['complete-known-processed-output','exact-source-serials']});
    expect(DEFAULT_DIRECT_HANDOFFS.map(link=>link.to)).not.toContain(StageId.STORAGE);
  });

  it('offers Storage only declared product candidates, without inferring acceptance or QA',()=>{
    for(const candidate of OPTIONAL_STORAGE_OUTPUTS){
      expect(MATERIAL_FLOW_BLUEPRINT[candidate.from].outputs.some(output=>output.material===candidate.material)).toBe(true);
      expect(candidate.requires).toEqual(['approved-catalogue-mapping','independent-physical-count','quarantine','separate-chief-qa']);
    }
    expect(OPTIONAL_STORAGE_OUTPUTS.some(row=>row.material==='sorted-electrodes')).toBe(true);
    expect(OPTIONAL_STORAGE_OUTPUTS.some(row=>row.material==='formed-cells')).toBe(true);
  });

  it('includes pouch as a planned target, not as an already-supported Assembly format',()=>{
    expect(CELL_FORMAT_PLANS).toContainEqual({format:'pouch',state:'planned'});
    expect(CELL_FORMAT_PLANS).toContainEqual({format:'cylindrical',state:'existing'});
    expect(CELL_FORMAT_PLANS).toContainEqual({format:'prismatic',state:'existing'});
  });
});
