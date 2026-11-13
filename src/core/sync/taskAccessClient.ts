import type { HybridSession } from './hybridClient';
import { requireFreshDeviceProof } from './deviceProofClient';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Recheck server visibility whenever a new device proof is obtained or a
 * manual synchronization completes. No local data is deleted by this call. */
export async function fetchAuthorizedTaskIds(session: HybridSession): Promise<string[]> {
  const { deviceId, token } = requireFreshDeviceProof(session);
  const base = new URL(session.serverUrl);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname)))
    throw new Error('Task access requires HTTPS');
  if (base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== ''))
    throw new Error('Task access requires a server origin without credentials or path');
  const url = new URL('/sync/task-access', base);
  url.searchParams.set('deviceId', deviceId);
  const response = await fetch(url.toString(), {
    headers: { Authorization: 'Bearer ' + session.accessToken, 'x-device-proof': token },
  });
  if (!response.ok) throw new Error('Could not verify task access: HTTP ' + response.status);
  const result: unknown = await response.json();
  const ids = (result as { ids?: unknown })?.ids;
  if (!Array.isArray(ids) || ids.length > 5000 || !ids.every(id => typeof id === 'string' && uuid.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new Error('Invalid server task access snapshot');
  }
  return ids;
}
