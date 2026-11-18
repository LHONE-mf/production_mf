import { TaskPriority, TaskStatus, StageId, type Task } from '../types';

export interface TaskPayloadV1 {
  schemaVersion: 1;
  title: string; description: string; status: TaskStatus; priority: TaskPriority;
  assignedTo: string | null; createdBy: string;
  createdAt: string; updatedAt: string; dueDate: string | null;
  techCardId: string | null; stage: StageId | null; workshopId: string | null;
  comments: Array<{id:string;taskId:string;authorId:string;text:string;createdAt:string}>;
  attachments: Array<{id:string;taskId:string;fileName:string;fileType:string;data:string;createdAt:string}>;
}
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(value: string, field: string) {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error(field + ' must be a UUID');
}
function validateLocation(stage: unknown, workshopId: unknown) {
  if (stage != null && !Object.values(StageId).includes(stage as StageId))
    throw new Error('Invalid task stage');
  if (workshopId != null && (typeof workshopId !== 'string' || workshopId.length > 120))
    throw new Error('Invalid task workshop');
}
/** Mirror server task-schema limits before enqueueing or accepting task children. */
function assertTaskChildLimits(
  comments: Array<{ text: string }>,
  attachments: Array<{ fileName: string; fileType: string; data: string }>,
) {
  if (!Array.isArray(comments) || comments.length > 1000 ||
      !Array.isArray(attachments) || attachments.length > 30)
    throw new Error('Invalid task child record count');
  if (comments.some(comment => !comment || typeof comment.text !== 'string' || comment.text.length > 10_000))
    throw new Error('Invalid task comment length');
  if (attachments.some(attachment => !attachment ||
      typeof attachment.fileName !== 'string' || attachment.fileName.length > 255 ||
      typeof attachment.fileType !== 'string' || attachment.fileType.length > 120 ||
      typeof attachment.data !== 'string' || attachment.data.length > 1_000_000))
    throw new Error('Invalid task attachment length');
}
function optionalId(value: unknown, local: boolean) {
  if (value === null || (local && (value === undefined || value === ''))) return;
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error('Invalid optional task field');
}
function date(value: Date, field: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Invalid date: ' + field);
  return value.toISOString();
}
export function encodeTask(task: Task): TaskPayloadV1 {
  uuid(task.id, 'task.id'); uuid(task.createdBy, 'task.createdBy');
  optionalId(task.assignedTo, true);
  optionalId(task.techCardId, true);
  if (task.dueDate != null && !(task.dueDate instanceof Date))
    throw new Error('Invalid optional task field');
  validateLocation(task.stage, task.workshopId);
  assertTaskChildLimits(task.comments, task.attachments);
  for (const comment of task.comments) {
    uuid(comment.id,'comment.id'); uuid(comment.taskId,'comment.taskId'); uuid(comment.authorId,'comment.authorId');
    if (comment.taskId !== task.id) throw new Error('Comment task mismatch');
  }
  for (const attachment of task.attachments) {
    uuid(attachment.id,'attachment.id'); uuid(attachment.taskId,'attachment.taskId');
    if (attachment.taskId !== task.id) throw new Error('Attachment task mismatch');
  }
  return {
    schemaVersion: 1, title: task.title, description: task.description,
    status: task.status, priority: task.priority, assignedTo: task.assignedTo || null,
    createdBy: task.createdBy, createdAt: date(task.createdAt,'createdAt'),
    updatedAt: date(task.updatedAt,'updatedAt'), dueDate: task.dueDate ? date(task.dueDate,'dueDate') : null,
    techCardId: task.techCardId || null, stage: task.stage || null, workshopId: task.workshopId || null,
    comments: task.comments.map(c => ({...c, createdAt: date(c.createdAt,'comment.createdAt')})),
    attachments: task.attachments.map(a => ({...a, createdAt: date(a.createdAt,'attachment.createdAt')})),
  };
}
function parseRemoteDate(value: string, field: string): Date {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid remote task date: ' + field);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Invalid remote task date: ' + field);
  return parsed;
}
export function decodeTask(id: string, payload: TaskPayloadV1): Task {
  uuid(id, 'task.id');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.schemaVersion !== 1) throw new Error('Unsupported task payload version');
  // The typed network contract does not guarantee runtime JSON types.
  if (typeof payload.title !== 'string' || typeof payload.description !== 'string' ||
      !Array.isArray(payload.comments) || !Array.isArray(payload.attachments)) {
    throw new Error('Invalid remote task fields');
  }
  assertTaskChildLimits(payload.comments, payload.attachments);
  const statuses = Object.values(TaskStatus);
  const priorities = Object.values(TaskPriority);
  if (!statuses.includes(payload.status) || !priorities.includes(payload.priority)) throw new Error('Invalid task status/priority');
  const createdAt = parseRemoteDate(payload.createdAt, 'createdAt');
  const updatedAt = parseRemoteDate(payload.updatedAt, 'updatedAt');
  if (updatedAt.getTime() < createdAt.getTime()) throw new Error('Invalid remote task date order');
  optionalId(payload.assignedTo, false);
  optionalId(payload.techCardId, false);
  if (payload.dueDate !== null &&
      (typeof payload.dueDate !== 'string' || !payload.dueDate.trim()))
    throw new Error('Invalid optional task field');
  const dueDate = payload.dueDate === null ? undefined : parseRemoteDate(payload.dueDate, 'dueDate');
  uuid(payload.createdBy, 'task.createdBy');
  validateLocation(payload.stage, payload.workshopId);
  for (const comment of payload.comments) {
    if (!comment || typeof comment !== 'object' || Array.isArray(comment) ||
        typeof comment.text !== 'string') throw new Error('Invalid remote task comment');
    uuid(comment.id, 'comment.id');
    uuid(comment.taskId, 'comment.taskId');
    uuid(comment.authorId, 'comment.authorId');
    if (comment.taskId !== id) throw new Error('Remote comment task mismatch');
  }
  for (const attachment of payload.attachments) {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment) ||
        typeof attachment.fileName !== 'string' || typeof attachment.fileType !== 'string' ||
        typeof attachment.data !== 'string') throw new Error('Invalid remote task attachment');
    uuid(attachment.id, 'attachment.id');
    uuid(attachment.taskId, 'attachment.taskId');
    if (attachment.taskId !== id) throw new Error('Remote attachment task mismatch');
  }
  return {
    id, title: payload.title, description: payload.description,
    status: payload.status, priority: payload.priority, assignedTo: payload.assignedTo || '',
    createdBy: payload.createdBy, createdAt, updatedAt,
    ...(dueDate ? { dueDate } : {}),
    ...(payload.techCardId ? {techCardId:payload.techCardId} : {}),
    ...(payload.stage ? {stage:payload.stage} : {}),
    ...(payload.workshopId ? {workshopId:payload.workshopId} : {}),
    comments: payload.comments.map(c => ({
      id: c.id, taskId: c.taskId, authorId: c.authorId, text: c.text,
      createdAt: parseRemoteDate(c.createdAt, 'comment.createdAt'),
    })),
    attachments: payload.attachments.map(a => ({
      id: a.id, taskId: a.taskId, fileName: a.fileName, fileType: a.fileType, data: a.data,
      createdAt: parseRemoteDate(a.createdAt, 'attachment.createdAt'),
    })),
  };
}
