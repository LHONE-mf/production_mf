import { StageId, TaskPriority, TaskStatus, UserRole, type SyncPacket, type Task } from '../core/types';

export const MAX_PACKET_BYTES = 1024 * 1024;
export const MAX_ENCODED_CHARS = 1_500_000;
export const MAX_FRAME_PART = 2048;
export const MAX_FRAMES = 1200;
export const MAX_ASSEMBLIES = 16;
export const MAX_ASSEMBLY_CHARS = 3_000_000;
export const FRAME_TTL_MS = 5 * 60 * 1000;

const types = new Set(['task', 'result', 'journal', 'storage-history', 'comment', 'user', 'mix-batch',
  'mix-component', 'mix-recipe', 'coating-mix', 'coat-run', 'roll-spec', 'calender-result', 'cutting-roll',
  'cut-run', 'sort-spec', 'sort-run', 'sort-handoff', 'defect-entry', 'assembly-run', 'electrolyte-in', 'fill-run',
  'walzing-in', 'walz-run', 'formation-in', 'formation-run', 'chat', 'forced-push']);
const administrativeTypes = new Set(['user', 'mix-component', 'mix-recipe', 'sort-spec']);
export const validId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200;
export const validEpoch = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 8.64e15;
export function dateEpoch(v: unknown): number {
  if (!(v instanceof Date) && typeof v !== 'string' && typeof v !== 'number') return NaN;
  const value = new Date(v).getTime();
  return validEpoch(value) ? value : NaN;
}
export function validEnvelope(value: unknown): value is SyncPacket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const p = value as SyncPacket;
  return p.v === 1 && types.has(p.type) && validId(p.from) && validEpoch(p.ts) &&
    !!p.payload && typeof p.payload === 'object' && !Array.isArray(p.payload) &&
    (p.role === undefined || Object.values(UserRole).includes(p.role)) &&
    (p.stage === undefined || Object.values(StageId).includes(p.stage)) &&
    (p.forced === undefined || typeof p.forced === 'boolean') &&
    (p.sig === undefined || typeof p.sig === 'string' && p.sig.length <= 256);
}

/** A shared HMAC proves group-key possession, never individual entitlement.
 * Source-bound observations still pass their immutable-history guards; their
 * declared actor/role remains unverified attribution, not account or QA authority. */
export function unsafeLegacyWrite(p: SyncPacket): string | null {
  const payload = p.payload as Record<string, unknown>;
  if (p.forced || p.type === 'forced-push' || administrativeTypes.has(p.type) ||
    p.type === 'roll-spec' && payload.calenderParams != null) {
    return 'Общий ключ не подтверждает личность и права отправителя. Учётные записи, справочники, параметры технолога и forced-запись через QR/Bluetooth заблокированы; используйте разрешённое локальное редактирование или защищённый сервер.';
  }
  return null;
}

export function incomingTask(value: unknown): Task | null {
  if (!value || typeof value !== 'object') return null;
  const t = value as Task;
  const created = dateEpoch(t.createdAt), updated = dateEpoch(t.updatedAt);
  if (!validId(t.id) || typeof t.title !== 'string' || !t.title.trim() || t.title.length > 1000 ||
    typeof t.description !== 'string' || t.description.length > 100_000 ||
    !Object.values(TaskStatus).includes(t.status) || !Object.values(TaskPriority).includes(t.priority) ||
    !validId(t.createdBy) || typeof t.assignedTo !== 'string' || t.assignedTo.length > 200 ||
    !Array.isArray(t.comments) || !Array.isArray(t.attachments) ||
    !Number.isFinite(created) || !Number.isFinite(updated) || updated < created ||
    (t.techCardId !== undefined && !validId(t.techCardId)) ||
    (t.workshopId !== undefined && !validId(t.workshopId)) ||
    (t.stage !== undefined && !Object.values(StageId).includes(t.stage)) ||
    (t.dueDate !== undefined && !Number.isFinite(dateEpoch(t.dueDate)))) return null;
  if (t.comments.length > 1000 || t.attachments.length > 1000 || t.comments.some(c =>
    !c || !validId(c.id) || c.taskId !== t.id || !validId(c.authorId) || typeof c.text !== 'string' ||
    c.text.length > 100_000 || !Number.isFinite(dateEpoch(c.createdAt))) || t.attachments.some(a =>
    !a || !validId(a.id) || a.taskId !== t.id || typeof a.fileName !== 'string' || !a.fileName.trim() ||
    typeof a.fileType !== 'string' || typeof a.data !== 'string' || !Number.isFinite(dateEpoch(a.createdAt)))) return null;
  return { ...t, createdAt: new Date(created), updatedAt: new Date(updated),
    comments: t.comments.map(c => ({ ...c, createdAt: new Date(dateEpoch(c.createdAt)) })),
    attachments: t.attachments.map(a => ({ ...a, createdAt: new Date(dateEpoch(a.createdAt)) })),
    ...(t.dueDate === undefined ? {} : { dueDate: new Date(dateEpoch(t.dueDate)) }) };
}
