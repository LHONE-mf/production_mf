import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {db} from './core/db';
import {useAuthStore} from './core/store/authStore';
import {UserRole,type User} from './core/types';
import App from './App';
vi.mock('./core/db',async original=>({...await original<typeof import('./core/db')>(),initializeDatabase:vi.fn(async()=>{})}));
const protectedRender=vi.hoisted(()=>vi.fn());
vi.mock('./shared/layouts/AppLayout',()=>({AppLayout:()=>{protectedRender();return <p data-testid="protected">Protected supervisor screen</p>;}}));
let user:User,node:HTMLDivElement,root:Root;
beforeEach(async()=>{protectedRender.mockClear();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);await db.open();user={id:'chief',login:'chief',fullName:'Chief',password:'test-only',role:UserRole.CHIEF,isActive:true,createdAt:new Date()};await db.users.add(user);useAuthStore.getState().logout();node=document.createElement('div');document.body.appendChild(node);root=createRoot(node);});
afterEach(async()=>{await act(async()=>root.unmount());node.remove();useAuthStore.getState().logout();db.close();await db.delete();localStorage.clear();vi.restoreAllMocks();vi.unstubAllGlobals();});
it('does not render protected content from a historical authenticated cache while IndexedDB verification is pending',async()=>{
 localStorage.setItem('auth-storage',JSON.stringify({version:0,state:{isAuthenticated:true,currentUser:user,session:{userId:user.id,role:user.role,expiresAt:new Date(Date.now()+100_000)}}}));await useAuthStore.persist.rehydrate();
 let resolve!:(value:User)=>void;const pending=new Promise<User>(done=>{resolve=done;});const lookup=vi.spyOn(db.users,'get').mockImplementation((()=>pending) as never);
 await act(async()=>root.render(<App/>));expect(protectedRender).not.toHaveBeenCalled();
 // Database readiness/live-query delivery can precede the separate profile check
 // by several turns on CI. Keep the identity lookup pending throughout that wait.
 await vi.waitFor(()=>{expect(protectedRender).not.toHaveBeenCalled();expect(node.textContent).toContain('Проверяем локальный профиль');});
 await act(async()=>resolve(user));await vi.waitFor(()=>expect(node.querySelector('[data-testid="protected"]')).not.toBeNull());lookup.mockRestore();
});
it('removes an already-open protected screen when the local profile loses its role',async()=>{
 useAuthStore.getState().login(user);await act(async()=>root.render(<App/>));await vi.waitFor(()=>expect(node.querySelector('[data-testid="protected"]')).not.toBeNull());
 await act(async()=>db.users.update(user.id,{role:UserRole.WORKER}));await vi.waitFor(()=>expect(node.textContent).toContain('Войти в систему'));expect(node.querySelector('[data-testid="protected"]')).toBeNull();expect(useAuthStore.getState().permissions).toBeNull();
});
