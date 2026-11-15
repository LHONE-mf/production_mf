import {it,expect} from 'vitest';
import {UserRole} from '../../core/types';
import {emptyCoatingForm,coatingFormEntry,parseCoatingForm} from './coatingDraft';
import {prepareRecordedCoatingRun} from './coatingJournal';
it('retains raw blanks/zeros/comma decimals, requires explicit mode, and never fills unknown ovens or measured thickness',()=>{
 const form={...emptyCoatingForm(),foilType:'Al',targetDry:'20,',widthCm:'50',webSpeed:'8',segs:['10,125'],sideB:'0'};
 expect(()=>coatingFormEntry(form)).toThrow();form.mode='continuous';const entry=coatingFormEntry(form);expect(entry.segLengthsM).toEqual([10.125]);expect(entry.sideBLengthM).toBe(0);expect(entry.ovenTempsC).toEqual([]);expect(entry.measuredDryThicknessUm).toBeUndefined();expect(form.targetDry).toBe('20,');expect(form.ovens).toEqual(Array(6).fill(''));
 expect(coatingFormEntry({...form,gapWidth:'unfinished',gapPitch:'-'}).gapWidthMm).toBeUndefined();
 expect(()=>coatingFormEntry({...form,widthCm:'bad'})).toThrow();expect(()=>prepareRecordedCoatingRun(coatingFormEntry({...form,ovens:['0','','','','','']}),'worker','id',UserRole.WORKER)).toThrow();
});
it('validates exact frozen intent on restore and preserves incomplete metadata for review rather than inventing a new operation',()=>{
 const form={...emptyCoatingForm(),foilType:'Al',targetDry:'20',widthCm:'50',webSpeed:'8',mode:'continuous' as const,segs:['10']};form.attempt=prepareRecordedCoatingRun(coatingFormEntry(form),'worker','fixed',UserRole.WORKER,1);
 expect(parseCoatingForm(form,'worker')).toEqual(form);expect(()=>parseCoatingForm({...form,widthCm:'51'},'worker')).toThrow();expect(()=>parseCoatingForm({...form,attempt:undefined},'worker')).toThrow();expect(()=>parseCoatingForm(form,'other')).toThrow();expect(()=>parseCoatingForm({...form,version:99},'worker')).toThrow();
});
