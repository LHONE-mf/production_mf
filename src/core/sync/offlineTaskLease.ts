import { db } from '../db';

export interface OfflineTaskEditLease {
  id: 'active';
  deviceId: string;
  actorId: string;
  organizationId: string;
  role: 'chief' | 'master';
  /** Never valid longer than the server-issued device proof. */
  expiresAt: number;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * A short-lived offline edit capability is provisioned only after authenticating
 * a specific AndroidKeyStore device with the server. This contains no bearer
 * token or private key, and does not bypass server authorization on reconnect.
 */
export async function provisionOfflineTaskEditLease(input: Omit<OfflineTaskEditLease, 'id'>) {
  if (!uuid.test(input.deviceId) || !uuid.test(input.actorId) || !uuid.test(input.organizationId) ||
      (input.role !== 'chief' && input.role !== 'master') ||
      !Number.isSafeInteger(input.expiresAt) ||
      input.expiresAt <= Date.now() || input.expiresAt > Date.now() + 300_000) {
    throw new Error('Invalid offline task edit authorization');
  }
  await db.hybridTaskEditLeases.put({ ...input, id: 'active' });
}

export async function requireOfflineTaskEditLease(): Promise<OfflineTaskEditLease> {
  const lease = await db.hybridTaskEditLeases.get('active');
  if (!lease || !uuid.test(lease.deviceId) || !uuid.test(lease.actorId) ||
      !uuid.test(lease.organizationId) ||
      (lease.role !== 'chief' && lease.role !== 'master') ||
      !Number.isSafeInteger(lease.expiresAt) || lease.expiresAt <= Date.now()) {
    throw new Error('Подтвердите устройство в разделе синхронизации, чтобы редактировать серверные задания');
  }
  return lease;
}

export async function clearOfflineTaskEditLease() {
  await db.hybridTaskEditLeases.delete('active');
}
