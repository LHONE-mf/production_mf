import {useEffect} from 'react';
import {useAuthStore,currentLocalSession} from '../store/authStore';
import {autoSyncLocalReceipts} from './localWarehouseReceipts';
import {useServerConnection} from './serverConnection';

/** Mounted for any authenticated screen: reconnect does not require visiting
 * Storage. Only explicitly saved offline receipt intents are auto-posted. */
export function InventoryReceiptReconnect(){
 const connection=useServerConnection();
 const userId=useAuthStore(s=>s.currentUser?.id);
 const localSession=useAuthStore(s=>s.session);
 useEffect(()=>{
  if(!connection||!userId||localSession?.userId!==userId||
    !currentLocalSession(localSession))return;
  const attempt=()=>{
   void autoSyncLocalReceipts(connection,userId)
    .catch(()=>{/* Offline/authorization errors leave exact pending IDs intact. */});
  };
  attempt();
  window.addEventListener('online',attempt);
  return()=>window.removeEventListener('online',attempt);
 },[connection,userId,localSession?.issuedAt]);
 return null;
}
