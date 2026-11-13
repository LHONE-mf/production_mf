import {expect,it} from 'vitest';
import {validAssemblyCounts,parseAssemblyCounts} from './assemblyCounts';
it('rejects nonfinite and unsafe numbers at the persistence guard and does not coerce blank to zero',()=>{
 for(const invalid of [NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,-1,0.5]){
  for(const key of ['qtyIn','qtyOut','qtyScrap'])expect(validAssemblyCounts({...{qtyIn:10,qtyOut:0,qtyScrap:10},[key]:invalid})).toBe(false);
 }
 expect(parseAssemblyCounts('10','0',' ')).toBeNull();
 expect(parseAssemblyCounts('10','0','0')).toEqual({qtyIn:10,qtyOut:0,qtyScrap:0});
});
