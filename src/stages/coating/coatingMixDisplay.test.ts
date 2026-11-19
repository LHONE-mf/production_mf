import {expect,it} from 'vitest';
import type {CoatingMixSnapshot} from '../../core/types';
import {coatingMixMassDisplay,formatCoatingPercent} from './coatingMixDisplay';

const measured={mixBatchId:'batch',recipeName:'Test',createdAt:1,handoverVersion:1 as const,
 solidsBasis:'weighed-masses-and-declared-composition' as const,
 batchKg:99.997,sourceBatch:{massBalance:{solidsActualG:99997}}} as CoatingMixSnapshot;

it('converts the actual dry-solids mass from recorded grams into kilograms for protected handovers',()=>{
 expect(coatingMixMassDisplay(measured)).toEqual({label:'Расчёт СВ по навескам',value:'99,997 кг'});
});

it('does not present an old 99997-gram value as 99997 kg; flags inconsistent handover without editing it',()=>{
 const inconsistent={...measured,batchKg:99997};
 const snapshot=JSON.stringify(inconsistent);
 const display=coatingMixMassDisplay(inconsistent);
 expect(display.value).toBe('99,997 кг');
 expect(display.warning).toMatch(/Несовпадение/);
 expect(JSON.stringify(inconsistent)).toBe(snapshot);
});

it('keeps unverified older batch quantities explicitly labelled as planned instead of measured',()=>{
 const legacy={mixBatchId:'legacy',recipeName:'Old',createdAt:1,batchKg:100} as CoatingMixSnapshot;
 expect(coatingMixMassDisplay(legacy)).toEqual({label:'План СВ (исторический)',value:'100 кг'});
 expect(formatCoatingPercent(55.55481480246893)).toBe('55,555');
});
