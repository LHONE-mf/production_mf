import {invalidateInventoryOfflineViews} from './inventoryOutbox';
import { useSyncExternalStore } from 'react';
import type { HybridSession } from './hybridClient';

/** Server credentials are deliberately memory-only. Never persist or transfer
 * them to the legacy local-demo login session or IndexedDB. */
export interface ServerConnection {
  session: HybridSession;
  serverUrl: string;
  organizationId: string;
  serverRole: string;
  serverActorId: string;
  selectedDeviceId: string;
  enrolledDeviceId: string;
  myDevices: string[];
}

let current: ServerConnection | null = null;
const listeners = new Set<() => void>();

export function getServerConnection(): ServerConnection | null {
  return current;
}

export function subscribeServerConnection(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setServerConnection(next: ServerConnection | null): void {
  if(current&&(!next||['serverUrl','organizationId','serverActorId','selectedDeviceId'].some(key=>current![key as keyof ServerConnection]!==next[key as keyof ServerConnection])))void invalidateInventoryOfflineViews();
  current = next;
  for (const listener of listeners) listener();
}

export function clearServerConnection(): void {
  if(!current)void invalidateInventoryOfflineViews();
  setServerConnection(null);
}

export function useServerConnection(): ServerConnection | null {
  return useSyncExternalStore(subscribeServerConnection, getServerConnection, () => null);
}
