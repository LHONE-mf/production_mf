import type { RemoteTaskChange } from './hybridClient';

/** Remote change saved durably when an offline edit blocks applying that task.
 * The pull cursor can advance for unrelated tasks without losing replay data. */
export interface DeferredTaskChange {
  sequence: number;
  entityId: string;
  change: RemoteTaskChange;
}
