import {beforeEach,afterEach,it,expect} from 'vitest';
import {db} from '../db';
import {UserRole,type User} from '../types';
import {useAuthStore} from './authStore';
import {getServerConnection,setServerConnection} from '../sync/serverConnection';
let user:User;
beforeEach(async()=>{await db.open();user={id:'local-chief',login:'chief',fullName:'Local chief',password:'pbkdf2$do-not-cache',role:UserRole.CHIEF,isActive:true,createdAt:new Date()};await db.users.add(user);localStorage.clear();useAuthStore.getState().logout();});
afterEach(async()=>{useAuthStore.getState().logout();db.close();await db.delete();localStorage.clear();});
it('persists only a bounded local session reference, never user/password/permission/token copies',()=>{
 useAuthStore.getState().login(user);const raw=localStorage.getItem('auth-storage')!;const value=JSON.parse(raw).state;expect(Object.keys(value)).toEqual(['session']);expect(raw).not.toContain(user.password);expect(raw).not.toContain('fullName');expect(raw).not.toContain('permissions');expect(raw).not.toContain('token');
});
it('scrubs historical full-state caches and denies authority until the current IndexedDB profile is verified',async()=>{
 const expiry=new Date(Date.now()+3_600_000);localStorage.setItem('auth-storage',JSON.stringify({version:0,state:{currentUser:user,permissions:{canManageUsers:true},isAuthenticated:true,session:{userId:user.id,role:user.role,login:user.login,token:'old-local-token',expiresAt:expiry}}}));
 await useAuthStore.persist.rehydrate();expect(useAuthStore.getState().isAuthenticated).toBe(false);expect(useAuthStore.getState().currentUser).toBeNull();expect(localStorage.getItem('auth-storage')).not.toContain(user.password);
 await useAuthStore.getState().verifyLocalSession();expect(useAuthStore.getState().isAuthenticated).toBe(true);expect(useAuthStore.getState().currentUser?.id).toBe(user.id);expect(useAuthStore.getState().session?.expiresAt.getTime()).toBe(expiry.getTime());
});
it.each(['expired','disabled','deleted','role-changed'] as const)('invalidates %s authority and clears server credentials/lease without changing work or pending sync',async cause=>{
 useAuthStore.getState().login(user);await db.journal.add({id:'kept-work',stage:'storage' as never,workerId:user.id,summary:'Keep',createdAt:new Date()});await db.hybridTaskOutbox.put({operationId:'keep-pending',entityId:'task',state:'pending',queuedAt:1} as never);await db.hybridTaskEditLeases.put({id:'active',actorId:'server-actor'} as never);setServerConnection({session:{accessToken:'memory-only-secret'}} as never);
 if(cause==='expired')useAuthStore.setState({session:{...useAuthStore.getState().session!,expiresAt:new Date(Date.now()-1)}});
 if(cause==='disabled')await db.users.update(user.id,{isActive:false});if(cause==='deleted')await db.users.delete(user.id);if(cause==='role-changed')await db.users.update(user.id,{role:UserRole.WORKER});
 await useAuthStore.getState().verifyLocalSession();expect(useAuthStore.getState().isAuthenticated).toBe(false);expect(useAuthStore.getState().permissions).toBeNull();expect(getServerConnection()).toBeNull();expect(await db.hybridTaskEditLeases.count()).toBe(0);expect(await db.journal.count()).toBe(1);expect(await db.hybridTaskOutbox.count()).toBe(1);
});
it('does not extend cached sessions and rejects future/invalid cache dates without altering saved users',async()=>{
 for(const expiresAt of ['invalid',new Date(Date.now()+172_800_000)]){
  localStorage.setItem('auth-storage',JSON.stringify({version:1,state:{session:{userId:user.id,role:user.role,expiresAt}}}));await useAuthStore.persist.rehydrate();await useAuthStore.getState().verifyLocalSession();expect(useAuthStore.getState().isAuthenticated).toBe(false);
 }
 expect((await db.users.get(user.id))?.password).toBe(user.password);
});
