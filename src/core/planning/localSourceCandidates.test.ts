import { describe, expect, it } from 'vitest';
import type { JournalEntry, MixBatch, CoatRun } from '../types';
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
      expect.objectContaining({key:'journal:'+id,sourceMeasure:undefined}),
      expect.objectContaining({key:'mix_batch:'+id,sourceStage:'slurry',
        sourceMeasure:{kind:'dry_solids_kg',value:'1.123456'}}),
      expect.objectContaining({key:'coat_run:'+id,sourceStage:'coating',
        sourceMeasure:{kind:'coated_side_a_m',value:'124.500000'},defects:'Pinholes'}),
    ]));
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
      sourceKind:'mix_batch',sourceEntryId:id,sourceMeasure:undefined,
    })]);
    expect(mixes[1].batchKg).toBe(Infinity);
  });
});
