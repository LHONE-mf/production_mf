import{vi}from'vitest';
export const inventoryTestEpoch='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
/** Keep individual tests focused on their response while explicitly modeling stream preflight. */
export function stubInventoryFetch(mock:(url:URL,init?:RequestInit)=>unknown){
 vi.stubGlobal('fetch',(url:URL,init?:RequestInit)=>{
  if(url.pathname==='/inventory/stream')return Promise.resolve({ok:true,status:200,json:async()=>({organizationId:'11111111-1111-4111-8111-111111111111',actorId:'22222222-2222-4222-8222-222222222222',deviceId:url.searchParams.get('deviceId'),epoch:inventoryTestEpoch,postingEnabled:true,sequence:1000000})});
  return mock(url,init);
 });
}
