import {afterEach,describe,expect,it,vi} from 'vitest';
import {loadInventoryMaterials,loadInventoryLocations,loadWarehouseAccess} from './inventoryCatalogClient';
import type {InventoryScope} from './inventoryOutbox';

const scope:InventoryScope={
  serverUrl:'https://inventory.example',
  organizationId:'11111111-1111-4111-8111-111111111111',
  actorId:'22222222-2222-4222-8222-222222222222',
  deviceId:'33333333-3333-4333-8333-333333333333',
};
const session={
  serverUrl:scope.serverUrl,accessToken:'A'.repeat(43),
  deviceProofToken:'B'.repeat(43),deviceProofDeviceId:scope.deviceId,
  deviceProofExpiresAt:Date.now()+300_000,
};
const first='44444444-4444-4444-8444-444444444444';
const second='55555555-5555-4555-8555-555555555555';
const material=(id:string)=>({
  id,code:'MAT-1',name:'Material',category:'raw_material',baseUnit:'mg',
});
const location=(id:string)=>({
  id,parentId:null,label:'Warehouse',kind:'warehouse',active:true,
});
const response=(payload:unknown,status=200)=>({
  ok:status>=200&&status<300,status,json:async()=>payload,
}) as Response;

afterEach(()=>vi.unstubAllGlobals());

describe('validated warehouse catalogue client',()=>{
  it('reads only verified catalog pages with device-bound proof and stable continuation',async()=>{
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(response({materials:[material(first)],hasMore:true,nextAfter:first}))
      .mockResolvedValueOnce(response({materials:[material(second)],hasMore:false,nextAfter:null}))
      .mockResolvedValueOnce(response({locations:[location(first)],hasMore:false,nextAfter:null}));
    vi.stubGlobal('fetch',fetchMock);
    expect(await loadInventoryMaterials(session,scope,undefined,1)).toEqual({
      items:[material(first)],hasMore:true,nextAfter:first,
    });
    expect(await loadInventoryMaterials(session,scope,first,1)).toEqual({
      items:[material(second)],hasMore:false,nextAfter:null,
    });
    expect(await loadInventoryLocations(session,scope,undefined,1)).toEqual({
      items:[location(first)],hasMore:false,nextAfter:null,
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain('after='+first);
    for(const call of fetchMock.mock.calls){
      expect(call[1].headers.Authorization).toBe('Bearer '+session.accessToken);
      expect(call[1].headers['x-device-proof']).toBe(session.deviceProofToken);
    }
  });

  it('refuses malformed rows, duplicates, truncated continuation and forged metadata',async()=>{
    const malformed=[
      {materials:[material(first),material(first)],hasMore:false,nextAfter:null},
      {materials:[material(first)],hasMore:true,nextAfter:second},
      {materials:[{...material(first),baseUnit:'tons'}],hasMore:false,nextAfter:null},
      {materials:[material(first)],hasMore:false,nextAfter:first},
      {materials:[material(second),material(first)],hasMore:false,nextAfter:null},
    ];
    for(const payload of malformed){
      vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(payload)));
      await expect(loadInventoryMaterials(session,scope,undefined,2)).rejects.toThrow('Invalid inventory catalogue');
    }
  });

  it('never shows a future correction capability as implemented',async()=>{
    const access={level:'manager',canRecordReceipts:true,canManageCatalog:true,
      canCorrectStock:false,correctionRoleEligible:true};
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response(access)));
    expect(await loadWarehouseAccess(session,scope)).toEqual(access);
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({...access,canCorrectStock:true})));
    await expect(loadWarehouseAccess(session,scope)).rejects.toThrow('Invalid warehouse access');
  });

  it('fails closed for invalid pages, wrong device proof and HTTP errors',async()=>{
    const fetchMock=vi.fn().mockResolvedValue(response({materials:[],hasMore:false,nextAfter:null}));
    vi.stubGlobal('fetch',fetchMock);
    await expect(loadInventoryMaterials(session,scope,undefined,101)).rejects.toThrow('page');
    await expect(loadInventoryMaterials(session,scope,'not-a-uuid')).rejects.toThrow('page');
    await expect(loadInventoryMaterials({...session,deviceProofDeviceId:second},scope))
      .rejects.toThrow('proof mismatch');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(response({error:'forbidden'},403)));
    await expect(loadInventoryLocations(session,scope)).rejects.toThrow('HTTP 403');
  });
});
