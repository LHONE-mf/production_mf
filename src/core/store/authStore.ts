import {create} from 'zustand';
import {persist} from 'zustand/middleware';
import {type User,UserRole,type AuthSession,type RolePermissions} from '../types';
import {getPermissions} from '../permissions';
import {db} from '../db';
import {clearServerConnection} from '../sync/serverConnection';
import {clearOfflineTaskEditLease} from '../sync/offlineTaskLease';
const DAY=86_400_000;
function cachedSession(value:unknown):AuthSession|null {
 const raw=value as Partial<AuthSession>|null;
 if(!raw||typeof raw.userId!=='string'||!raw.userId.trim()||!Object.values(UserRole).includes(raw.role!))return null;
 const expiresAt=new Date(raw.expiresAt!);const issuedAt=raw.issuedAt??expiresAt.getTime()-DAY;
 if(!Number.isFinite(expiresAt.getTime())||!Number.isFinite(issuedAt))return null;
 return {userId:raw.userId,role:raw.role!,issuedAt,expiresAt};
}
export function currentLocalSession(session:AuthSession|null,now=Date.now()):boolean {
 return !!session&&typeof session.userId==='string'&&!!session.userId.trim()&&Object.values(UserRole).includes(session.role)&&session.issuedAt>0&&session.issuedAt<=now&&session.expiresAt.getTime()>now&&session.expiresAt.getTime()<=session.issuedAt+DAY;
}
interface AuthState {
 session:AuthSession|null;currentUser:User|null;permissions:RolePermissions|null;isAuthenticated:boolean;
 sessionChecked:boolean;sessionError:string;
 login:(user:User)=>void;logout:()=>void;verifyLocalSession:()=>Promise<void>;
}
let generation=0;
export const useAuthStore=create<AuthState>()(persist((set,get)=>({
 session:null,currentUser:null,permissions:null,isAuthenticated:false,sessionChecked:false,sessionError:'',
 login:user=>{
  if(get().currentUser?.id!==user.id)clearServerConnection();
  generation++;const now=Date.now();set({session:{userId:user.id,role:user.role,issuedAt:now,expiresAt:new Date(now+DAY)},currentUser:user,permissions:getPermissions(user.role),isAuthenticated:true,sessionChecked:true,sessionError:''});
 },
 logout:()=>{generation++;clearServerConnection();set({session:null,currentUser:null,permissions:null,isAuthenticated:false,sessionChecked:true,sessionError:''});},
 verifyLocalSession:async()=>{
  const attempt=++generation,session=get().session;
  try{
   const user=currentLocalSession(session)?await db.users.get(session!.userId):undefined;
   if(attempt!==generation||get().session!==session)return;
   if(user?.isActive===true&&user.role===session?.role&&currentLocalSession(session)){
    set({currentUser:user,permissions:getPermissions(user.role),isAuthenticated:true,sessionChecked:true,sessionError:''});return;
   }
   clearServerConnection();set({session:null,currentUser:null,permissions:null,isAuthenticated:false,sessionChecked:false,sessionError:''});
   await clearOfflineTaskEditLease();
   if(attempt===generation)set({sessionChecked:true});
  }catch{
   if(attempt!==generation)return;clearServerConnection();set({currentUser:null,permissions:null,isAuthenticated:false,sessionChecked:false,sessionError:'Не удалось проверить локальный доступ. Данные сохранены; повторите проверку.'});
  }
 },
}),{
 name:'auth-storage',version:1,
 partialize:state=>({session:state.session}),
 migrate:value=>({session:cachedSession((value as {session?:unknown})?.session)}),
 merge:(value,current)=>({...current,session:cachedSession((value as {session?:unknown})?.session),currentUser:null,permissions:null,isAuthenticated:false,sessionChecked:false,sessionError:''}),
}));
