import type { TaskPayloadV1 } from './taskDto';
import Dexie, { type Table } from 'dexie';

/** Separate database keeps existing production schema and migrations untouched. */
export interface PendingTaskOperation {
  operationId: string;
  deviceId: string;
  entityType: 'task';
  entityId: string;
  operationType: 'upsert';
  expectedRevision: number;
  payload: TaskPayloadV1;
  queuedAt: number;
  state: 'pending' | 'conflict';
  actualRevision?: number;
}

class HybridOutboxDb extends Dexie {
  operations!: Table<PendingTaskOperation, string>;
  metadata!: Table<{ key: string; value: number }, string>;
  constructor() {
    super('ProductionMfHybridOutbox');
    this.version(1).stores({ operations: 'operationId, entityId, state, queuedAt', metadata: 'key' });
  }
}
export const hybridOutbox = new HybridOutboxDb();

export async function queueTaskOperation(input: Omit<PendingTaskOperation, 'operationId' | 'queuedAt' | 'state'>) {
  const operation: PendingTaskOperation = { ...input, operationId: crypto.randomUUID(), queuedAt: Date.now(), state: 'pending' };
  await hybridOutbox.operations.add(operation);
  return operation.operationId;
}

export async function pendingTaskOperations() {
  return hybridOutbox.operations.where('state').equals('pending').sortBy('queuedAt');
}
export async function taskConflicts() {
  return hybridOutbox.operations.where('state').equals('conflict').toArray();
}
