import {expect,it} from 'vitest';
import {parseMassReadings,summarizeMassReadings} from './sortingMeasurement';
import type {SortCategory} from '../types';

const categories:SortCategory[]=[
  {name:'A',criteria:'low',minMass:1,maxMass:1.5},
  {name:'B',criteria:'high',minMass:1.5,maxMass:2},
];

it('parses one positive gram value per electrode with decimal comma or dot',()=>{
  expect(parseMassReadings('1,25\r\n1.8\n2.1\n',3)).toEqual([1.25,1.8,2.1]);
  for(const bad of ['1,2\n','1\n\n2','1.2\n0\n2','1.2\nNaN\n2','1.2\n1e2\n2','1.2\nInfinity\n2'])
    expect(()=>parseMassReadings(bad,3)).toThrow();
  expect(()=>parseMassReadings('1\n2',10001)).toThrow();
});

it('derives grade and reject quantities only from unambiguous measured masses',()=>{
  expect(summarizeMassReadings([1.2,1.8,2.5],categories,'grading')).toEqual({
    passedCount:2,rejectedCount:1,grades:[{categoryName:'A',count:1},{categoryName:'B',count:1}],
  });
  expect(summarizeMassReadings([1.2,1.8,2.5],categories,'pass-fail')).toMatchObject({
    passedCount:2,rejectedCount:1,
  });
  expect(()=>summarizeMassReadings([1.5],categories,'grading')).toThrow(/несколько сортов/);
  expect(()=>summarizeMassReadings([NaN],categories,'grading')).toThrow();
  expect(()=>summarizeMassReadings([0],categories,'grading')).toThrow();
  expect(()=>summarizeMassReadings([1.2],[{name:'A',criteria:'no mass KD'}],'grading')).toThrow(/отсутствуют/);
});


it('checks one thickness measurement per incoming electrode against KD without assigning a grade',async()=>{
  const {parseThicknessReadings,summarizeThicknessReadings}=await import('./sortingMeasurement');
  const limits:SortCategory[]=[
    {name:'A',criteria:'thin',minUm:70,maxUm:80},
    {name:'B',criteria:'thick',minUm:75,maxUm:85},
  ];
  expect(parseThicknessReadings('72,5\n78\n90',3)).toEqual([72.5,78,90]);
  expect(summarizeThicknessReadings([72.5,78,90],limits)).toEqual({passedCount:2,rejectedCount:1});
  expect(()=>parseThicknessReadings('72\n',2)).toThrow();
  expect(()=>summarizeThicknessReadings([0],limits)).toThrow();
  expect(()=>summarizeThicknessReadings([72],[{name:'A',criteria:'no thickness bounds'}])).toThrow();
});
