import { describe, expect, it } from 'vitest';
import type {
  AssemblyRun, JournalEntry, MixBatch, CoatRun, CalenderRun, CutRun, SortRun,
} from '../types';
import { localSourceCandidates } from './localSourceCandidates';

describe('selectable offline production source snapshots',()=>{
  const id='4e6ca295-b643-43bd-b44a-b39c380e6285';
  it('distinguishes source stores and labels mix dry solids and coating side A length',()=>{
    const result=localSourceCandidates(
      [{id,stage:'slurry',summary:'Operation noted',workerId:'worker',
        createdAt:new Date('2026-11-10T09:00:00Z')} as JournalEntry],
      [{id,recipeName:'LFP pilot',batchKg:1.123456,createdAt:1794312000000} as MixBatch],
      [{id,foilType:'Al 12µm',sideALengthM:124.5,createdAt:1794315600000,
        defects:'Pinholes'} as CoatRun],
    );
    expect(result).toHaveLength(3);
    expect(new Set(result.map(r=>r.key)).size).toBe(3);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({key:'journal:'+id}),
      expect.objectContaining({key:'mix_batch:'+id,sourceStage:'slurry',
        sourceMeasure:{kind:'dry_solids_kg',value:'1.123456'}}),
      expect.objectContaining({key:'coat_run:'+id,sourceStage:'coating',
        sourceMeasure:{kind:'coated_side_a_m',value:'124.500000'},defects:'Pinholes'}),
    ]));
  });
  it('labels calendered lengths and whole good-cut counts without auto-calculating yield',()=>{
    const calendar='99d0fd6d-2b3f-4db2-bd52-523bf8b6147e';
    const cut='314b31cc-29d7-44fa-8a19-d13d6007c20b';
    const cals=[{id:calendar,rollId:'ROLL-7',createdAt:1794312000000,
      totalLengthM:87.375,defects:'Edge tear'} as CalenderRun];
    const cuts=[{id:cut,incomingId:'ROLL-7',electrodeType:'strip',
      goodCount:154,createdAt:1794315600000} as CutRun];
    const result=localSourceCandidates([],[],[],cals,cuts);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({sourceKind:'calender_run',sourceStage:'calendaring',
        sourceEntryId:calendar,sourceMeasure:{kind:'calendered_length_m',value:'87.375000'},
        defects:'Edge tear'}),
      expect.objectContaining({sourceKind:'cut_run',sourceStage:'cutting',
        sourceEntryId:cut,sourceMeasure:{kind:'cut_good_pieces',value:'154.000000'}}),
    ]));
    expect(cals[0].totalLengthM).toBe(87.375);
    expect(cuts[0].goodCount).toBe(154);
  });
  it('does not round fractional or implausible cutting counts to whole pieces',()=>{
    const id='314b31cc-29d7-44fa-8a19-d13d6007c20b';
    const items=localSourceCandidates([],[],[],[],[
      {id,goodCount:14.4,electrodeType:'strip',createdAt:1794312000000} as CutRun,
      {id:'e86e8832-92a9-4db7-9b0e-57b2b56fb513',goodCount:Infinity,
        electrodeType:'strip',createdAt:1794312000000} as CutRun,
    ]);
    expect(items).toHaveLength(2);
    for(const item of items)expect(item).not.toHaveProperty('sourceMeasure');
  });
  it('distinguishes sorting input from assembly output and excludes invalid counts',()=>{
    const sortId='805f1325-676b-4fc7-b73b-20742d15c8f5';
    const assemblyId='dfb44d22-31b6-47b6-96e3-ff3ec3fa95bf';
    const sorting=[{id:sortId,batchName:'Cathode pilot',goodCount:74,
      defects:'Edge chips',createdAt:1794312000000} as SortRun];
    const assembly=[{id:assemblyId,batchName:'Cell pilot',cellsOut:40,
      defects:['Visual issue'],createdAt:'2026-11-10T10:00:00Z'} as AssemblyRun];
    const records=localSourceCandidates([],[],[],[],[],sorting,assembly);
    expect(records).toEqual(expect.arrayContaining([
      expect.objectContaining({key:'sort_run:'+sortId,sourceStage:'sorting',
        sourceMeasure:{kind:'sort_input_good_pieces',value:'74.000000'},
        defects:'Edge chips'}),
      expect.objectContaining({key:'assembly_run:'+assemblyId,sourceStage:'assembly',
        sourceMeasure:{kind:'assembled_cells_out',value:'40.000000'},
        defects:'Visual issue'}),
    ]));
    expect(records).toHaveLength(2);
    expect(sorting[0].goodCount).toBe(74);
    expect(assembly[0].cellsOut).toBe(40);
    const malformed=localSourceCandidates([],[],[],[],[],
      [{...sorting[0],id:'non-uuid'},
       {...sorting[0],goodCount:74.5}] as SortRun[],
      [{...assembly[0],cellsOut:0}, {...assembly[0],defects:[77]}] as unknown as AssemblyRun[]);
    expect(malformed).toHaveLength(2);
    for(const record of malformed)expect(record).not.toHaveProperty('sourceMeasure');
  });

  it('excludes demo IDs, malformed legacy rows and unsafe values without mutation',()=>{
    const journal=[
      {id:'jr-001',stage:'coating',summary:'demo',createdAt:new Date()},
      {id,stage:'coating',createdAt:new Date()},
      {id,stage:'coating',summary:'safe',createdAt:new Date(),
        defects:42},
    ] as unknown as JournalEntry[];
    const mixes=[
      {id:'mix-demo-01',recipeName:'demo',createdAt:1794312000000},
      {id,recipeName:'usable',batchKg:Number.POSITIVE_INFINITY,createdAt:1794312000000},
    ] as unknown as MixBatch[];
    const coat=[
      {id,foilType:'Cu',createdAt:1794312000000,
        defects:Array(2100).fill('x').join('')},
    ] as unknown as CoatRun[];
    const result=localSourceCandidates(journal,mixes,coat);
    expect(result).toEqual([expect.objectContaining({
      sourceKind:'mix_batch',sourceEntryId:id,
    })]);
    expect(result[0]).not.toHaveProperty('sourceMeasure');
    expect(mixes[1].batchKg).toBe(Infinity);
  });
});

it('does not label an intake or station observation ledger as assembled-cell output',()=>{
 const base:AssemblyRun={id:'dfb44d22-31b6-47b6-96e3-ff3ec3fa95bf',batchName:'Recorded batch',cellType:'cylindrical',ops:[],cellsOut:40,cellsScrap:0,workerId:'worker',defects:[],createdAt:'2026-11-10T10:00:00Z',updatedAt:'2026-11-10T10:00:00Z'};
 for(const record of [{...base,operationLedger:1 as const},{...base,intake:{sortRunId:'source',electrodeCount:8,recordedBy:'worker',recordedAt:base.createdAt}}]){
  const rows=localSourceCandidates([],[],[],[],[],[],[record]);expect(rows).toHaveLength(1);expect(rows[0]).not.toHaveProperty('sourceMeasure');
 }
});
it('uses separately declared cell output rather than a legacy aggregate in a sourced observation ledger',()=>{
 const record={id:'dfb44d22-31b6-47b6-96e3-ff3ec3fa95bf',batchName:'Declared output',cellType:'unassigned',ops:[],cellsOut:999,cellsScrap:0,workerId:'worker',defects:[],createdAt:'2026-11-10T10:00:00Z',updatedAt:'2026-11-10T10:00:00Z',operationLedger:1,cellOutput:{count:4}} as unknown as AssemblyRun;
 const rows=localSourceCandidates([],[],[],[],[],[],[record]);expect(rows[0]).toMatchObject({summary:'Заявленный выход ячеек: Declared output',sourceMeasure:{kind:'assembled_cells_out',value:'4.000000'}});
});
