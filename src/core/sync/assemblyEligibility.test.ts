import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {loadInventoryOutputs,type OfferedOutput} from './inventoryOutputs';
import {loadAvailableAssemblyGrades} from './assemblyEligibility';

vi.mock('./inventoryOutputs',()=>({loadInventoryOutputs:vi.fn()}));
const scope={serverUrl:'https://factory.example',organizationId:'11111111-1111-4111-8111-111111111111',
 actorId:'22222222-2222-4222-8222-222222222222',deviceId:'33333333-3333-4333-8333-333333333333'};
const session={serverUrl:scope.serverUrl,accessToken:'token',deviceProofToken:'A'.repeat(43),
 deviceProofDeviceId:scope.deviceId,deviceProofExpiresAt:Date.now()+300000};
const target={assemblyBatchId:'44444444-4444-4444-8444-444444444444',assemblyStepNumber:7,
 recipientId:'55555555-5555-4555-8555-555555555555'};
const epoch='66666666-6666-4666-8666-666666666666';
const source={
 operationId:'77777777-7777-4777-8777-777777777777',
 productionBatchId:'88888888-8888-4888-8888-888888888888',stepNumber:5,
 source:{runId:'sorted-batch-1'},
 outputs:[
  {grade:'A',quantity:4,materialId:'99999999-9999-4999-8999-999999999999',stockId:null},
  {grade:'B',quantity:3,materialId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',stockId:null},
  {grade:'C',quantity:1,materialId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',stockId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'},
 ],
} as unknown as OfferedOutput;
const offeredPage=(more=false)=>({organizationId:scope.organizationId,actorId:scope.actorId,deviceId:scope.deviceId,
 epoch,postingEnabled:true,items:[source],hasMore:more,nextAfter:more?source.operationId:null});
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const ok=(grade:string)=>({
 eligible:true,reservationEffect:'none',organizationId:scope.organizationId,actorId:scope.actorId,
 deviceId:scope.deviceId,epoch,submissionId:source.operationId,grade,
 quantity:grade==='A'?4:3,unit:'pieces',
 sourceBatchId:source.productionBatchId,sourceStepNumber:source.stepNumber,
 materialId:grade==='A'?source.outputs[0].materialId:source.outputs[1].materialId,
 assemblyBatchId:target.assemblyBatchId,assemblyStepNumber:target.assemblyStepNumber,
 recipientId:target.recipientId,
});
beforeEach(()=>{vi.mocked(loadInventoryOutputs).mockResolvedValue(offeredPage());});
afterEach(()=>{vi.resetAllMocks();vi.unstubAllGlobals();});

it('reads only server-confirmed grades with device proof; excludes warehouse-claimed grades and never posts',async()=>{
 const requests:string[]=[];
 vi.stubGlobal('fetch',vi.fn(async(url:URL,init:RequestInit)=>{
  const u=new URL(url);requests.push(u.toString());
  expect(init.method).toBeUndefined();
  expect((init.headers as Record<string,string>)['x-device-proof']).toBe(session.deviceProofToken);
  expect((init.headers as Record<string,string>).Authorization).toBe('Bearer token');
  expect(u.searchParams.get('recipientId')).toBe(target.recipientId);
  expect(u.searchParams.get('assemblyBatchId')).toBe(target.assemblyBatchId);
  return u.searchParams.get('grade')==='B'?reply({error:'sorting_grade_already_claimed'},409):reply(ok('A'));
 }));
 const result=await loadAvailableAssemblyGrades(session,scope,target);
 expect(result).toEqual({epoch,nextAfter:null,items:[{
  submissionId:source.operationId,grade:'A',quantity:4,materialId:source.outputs[0].materialId,
  sourceBatchId:source.productionBatchId,sourceStepNumber:5,sortRunId:'sorted-batch-1',
 }]});
 expect(requests).toHaveLength(2);expect(requests.every(url=>new URL(url).pathname.endsWith('/eligibility'))).toBe(true);
});

it('fails closed for denied reads, unknown conflicts and tampered quantity or scope',async()=>{
 let status=403,body:unknown={error:'sorting_supervisor_required'};
 vi.stubGlobal('fetch',vi.fn(async()=>reply(body,status)));
 await expect(loadAvailableAssemblyGrades(session,scope,target)).rejects.toThrow('HTTP 403');
 status=409;body={error:'unexpected_conflict'};
 await expect(loadAvailableAssemblyGrades(session,scope,target)).rejects.toThrow('HTTP 409');
 status=200;body={...ok('A'),quantity:400};
 await expect(loadAvailableAssemblyGrades(session,scope,target)).rejects.toThrow('не совпадает');
 body={...ok('A'),organizationId:crypto.randomUUID()};
 await expect(loadAvailableAssemblyGrades(session,scope,target)).rejects.toThrow('не совпадает');
});

it('does not send a request for missing or invalid Assembly destination',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 await expect(loadAvailableAssemblyGrades(session,scope,{...target,assemblyStepNumber:0})).rejects.toThrow('Укажите');
 await expect(loadAvailableAssemblyGrades(session,scope,{...target,recipientId:'wrong'})).rejects.toThrow('Укажите');
 expect(loadInventoryOutputs).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();
});

it('keeps continuation and server history scoped across pages',async()=>{
 vi.mocked(loadInventoryOutputs).mockResolvedValue(offeredPage(true));
 vi.stubGlobal('fetch',vi.fn(async(url:URL)=>reply(ok(new URL(url).searchParams.get('grade')!))));
 const first=await loadAvailableAssemblyGrades(session,scope,target);
 expect(first.nextAfter).toBe(source.operationId);
 await loadAvailableAssemblyGrades(session,scope,target,first.epoch,first.nextAfter??undefined);
 expect(loadInventoryOutputs).toHaveBeenLastCalledWith(session,scope,epoch,source.operationId,20);
});
