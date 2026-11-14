import {it,expect} from 'vitest';
import {inventoryLabel,parseInventoryLabel} from './inventoryIdentification';
it('round-trips only scoped typed identities and denies cross-tenant/malformed/action/secret labels',()=>{
 const org='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';for(const kind of ['container','location','batch']as const)expect(parseInventoryLabel(inventoryLabel(org,kind,id),org)).toEqual({kind,id});
 for(const bad of [inventoryLabel(id,'container',id),`production-mf:v1:${org}:container:${id}:release`,`production-mf:v1:${org}:container:demo-id`,`https://inventory.example?accessToken=secret`,`production-mf:v2:${org}:container:${id}`])expect(()=>parseInventoryLabel(bad,org)).toThrow();
});
