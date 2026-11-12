import {expect,it} from 'vitest';
import type {MixComponent} from '../types';
import {SLURRY_BASIS,calculateSlurryPlan,slurryMassBalance,parseSlurryNumber,validateSlurryComponent} from './slurryMath';
import {calcPasteProperties} from '../../stages/slurry/mixMath';

const components:MixComponent[]=[
 {id:'active',name:'Declared powder',kind:'active',solidsMassFraction:1,densityTrue:3,updatedAt:1},
 {id:'binder',name:'Declared binder solution',kind:'binder',solidsMassFraction:.5,densityTrue:1.2,updatedAt:1},
 {id:'liquid',name:'Declared liquid',kind:'solvent',solidsMassFraction:0,densityTrue:1,viscosity:1,updatedAt:1},
];
const lines=[{componentId:'active',pct:60},{componentId:'binder',pct:40},{componentId:'liquid',pct:50}];
it('uses explicit dry-solids percentages and known solution composition without silently normalizing',()=>{
 const plan=calculateSlurryPlan(lines,components,1.5,SLURRY_BASIS);
 expect(plan.rows.map(row=>row.grams)).toEqual([900,1200,750]);expect(plan).toMatchObject({dryTotalG:1500,wetTotalG:1350,allTotalG:2850});
 expect(plan.solidsPct).toBeCloseTo(1500/2850*100);
 for(const invalid of [[{componentId:'active',pct:80}],[...lines,lines[0]],[{componentId:'missing',pct:100}],[{componentId:'active',pct:-1}],[{componentId:'active',pct:NaN}]])expect(()=>calculateSlurryPlan(invalid,components,1.5,SLURRY_BASIS)).toThrow();
 expect(()=>calculateSlurryPlan(lines,components,0,SLURRY_BASIS)).toThrow();expect(()=>calculateSlurryPlan(lines,components,1.5,'wet-percent' as typeof SLURRY_BASIS)).toThrow();
});
it('keeps a missing mass unknown and an explicit zero measured, and derives solids only from complete known masses/composition',()=>{
 const weights=[{componentId:'active',actualG:900},{componentId:'binder',actualG:1200},{componentId:'liquid',actualG:700}];
 expect(slurryMassBalance(weights,components)).toMatchObject({knownMassG:2800,missingCount:0,totalActualG:2800,solidsActualG:1500,liquidActualG:1300});
 expect(slurryMassBalance(weights,components).solidsPctMass).toBeCloseTo(1500/2800*100);
 const incomplete=slurryMassBalance([...weights.slice(0,2),{componentId:'liquid',actualG:undefined}],components);
 expect(incomplete).toMatchObject({knownMassG:2100,missingCount:1});expect(incomplete.totalActualG).toBeUndefined();expect(incomplete.solidsPctMass).toBeUndefined();
 expect(slurryMassBalance([...weights.slice(0,2),{componentId:'liquid',actualG:0}],components)).toMatchObject({totalActualG:2100,missingCount:0});
 const unknownComposition=components.map(c=>c.id==='binder'?{...c,solidsMassFraction:undefined}:c);
 expect(slurryMassBalance(weights,unknownComposition).solidsPctMass).toBeUndefined();expect(()=>calculateSlurryPlan(lines,unknownComposition,1.5,SLURRY_BASIS)).toThrow();
});
it('accepts fractional mass and decimal comma while rejecting negative, nonfinite, malformed and missing required observations',()=>{
 expect(parseSlurryNumber('0,125')).toBe(.125);expect(parseSlurryNumber('0')).toBe(0);expect(parseSlurryNumber(' ')).toBeUndefined();
 for(const value of ['-1','Infinity','NaN','1,2,3','0x10'])expect(()=>parseSlurryNumber(value)).toThrow();
 expect(()=>parseSlurryNumber('',true)).toThrow();
 for(const patch of [{solidsMassFraction:1.1},{solidsMassFraction:-.1},{densityTrue:0},{viscosity:-1},{d50:Infinity}])expect(()=>validateSlurryComponent({...components[0],...patch})).toThrow();
});
it('does not invent component density, solvent viscosity or partial-solution dry volume for paste predictions',()=>{
 const plan=calculateSlurryPlan(lines,components,1.5,SLURRY_BASIS);
 expect(calcPasteProperties(plan.rows,new Map(components.map(c=>[c.id,c])),{phiMax:.62,shearRate:50})).toBeNull();
 const pure=[components[0],components[2]];const purePlan=calculateSlurryPlan([{componentId:'active',pct:100},{componentId:'liquid',pct:100}],pure,1,SLURRY_BASIS);
 expect(calcPasteProperties(purePlan.rows,new Map(pure.map(c=>[c.id,c])),{phiMax:.62,shearRate:50})).not.toBeNull();
 for(const property of ['densityTrue','viscosity'] as const){const missing=pure.map(c=>c.id==='liquid'?{...c,[property]:undefined}:c);expect(calcPasteProperties(purePlan.rows,new Map(missing.map(c=>[c.id,c])),{phiMax:.62,shearRate:50})).toBeNull();}
});
