import { db } from '../db';

/**
 * The current Dexie task tables are shared across accounts. Until records are
 * partitioned by tenant, bind this installation to ONE server + organization.
 * Refuse ambiguous pre-existing sync data instead of guessing its ownership.
 */
export async function assertSyncTenant(serverUrl: string, organizationId: string, actorId?: string): Promise<void> {
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
  const actor = actorId?.trim().toLowerCase();
  if (actor !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(actor)) {
    throw new Error('Invalid authenticated actor ID');
  }
  const actorKey = actor ? 'syncActor:' + origin + ':' + org + ':' + actor : null;
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
    if (actorKey) {
      const actorBindings = await db.hybridSyncMetadata.where('key').startsWith('syncActor:').toArray();
      if (actorBindings.some(binding => binding.key !== actorKey) || actorBindings.length > 1) {
        throw new Error('This installation belongs to another server user. Use a separate installation until per-user data isolation is supported.');
      }
      if (!actorBindings.length) {
        // A pre-existing shared task database cannot safely be assigned to an
        // arbitrary newly logged-in user. Preserve it untouched for migration.
        const cursor = await db.hybridSyncMetadata.get('taskCursor');
        if (cursor || await db.hybridTaskOutbox.count() || await db.hybridTaskRevisions.count()) {
          throw new Error('Existing synchronized data has no verified user ownership. Back up and migrate it before reconnecting.');
        }
        await db.hybridSyncMetadata.put({ key: actorKey, value: 1 });
      }
    }
  });
}
