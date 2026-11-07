import { db } from '../db';

/**
 * The current Dexie task tables are shared across accounts. Until records are
 * partitioned by tenant, bind this installation to ONE server + organization.
 * Refuse ambiguous pre-existing sync data instead of guessing its ownership.
 */
export async function assertSyncTenant(serverUrl: string, organizationId: string): Promise<void> {
  const url = new URL(serverUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('HTTPS required outside localhost');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('Server URL must be an origin without path, credentials or query');
  }
  const origin = url.origin.toLowerCase();
  const org = organizationId.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(org)) {
    throw new Error('Invalid organization ID');
  }
  const key = 'syncTenant:' + origin + ':' + org;
  await db.transaction('rw', db.hybridSyncMetadata, db.hybridTaskOutbox, db.hybridTaskRevisions, async () => {
    const bindings = await db.hybridSyncMetadata.where('key').startsWith('syncTenant:').toArray();
    if (bindings.length > 1 || bindings.some(binding => binding.key !== key)) {
      throw new Error('This device is linked to another organization or server. Use a separate app installation until tenant migration is supported.');
    }
    if (!bindings.length) {
      const legacyCursor = await db.hybridSyncMetadata.get('taskCursor');
      const existingOperations = await db.hybridTaskOutbox.count();
      const existingRevisions = await db.hybridTaskRevisions.count();
      if (legacyCursor || existingOperations || existingRevisions) {
        throw new Error('Existing synchronization data has no verified organization. Back up and migrate it before connecting.');
      }
      await db.hybridSyncMetadata.put({ key, value: 1 });
    }
  });
}
