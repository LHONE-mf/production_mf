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
  if (!uuidPattern.test(value)) throw new Error(field + ' must be a UUID');
}
function date(value: Date, field: string) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error('Invalid date: ' + field);
  return value.toISOString();
}
export function encodeTask(task: Task): TaskPayloadV1 {
  uuid(task.id, 'task.id'); uuid(task.createdBy, 'task.createdBy');
  if (task.assignedTo) uuid(task.assignedTo, 'task.assignedTo');
  if (task.techCardId) uuid(task.techCardId, 'task.techCardId');
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
export function decodeTask(id: string, payload: TaskPayloadV1): Task {
  uuid(id, 'task.id');
  if (payload.schemaVersion !== 1) throw new Error('Unsupported task payload version');
  const statuses = Object.values(TaskStatus);
  const priorities = Object.values(TaskPriority);
  if (!statuses.includes(payload.status) || !priorities.includes(payload.priority)) throw new Error('Invalid task status/priority');
  return {
    id, title: payload.title, description: payload.description,
    status: payload.status, priority: payload.priority, assignedTo: payload.assignedTo || '',
    createdBy: payload.createdBy, createdAt: new Date(payload.createdAt), updatedAt: new Date(payload.updatedAt),
    ...(payload.dueDate ? {dueDate:new Date(payload.dueDate)} : {}),
    ...(payload.techCardId ? {techCardId:payload.techCardId} : {}),
    ...(payload.stage ? {stage:payload.stage} : {}),
    ...(payload.workshopId ? {workshopId:payload.workshopId} : {}),
    comments: payload.comments.map(c => ({...c,createdAt:new Date(c.createdAt)})),
    attachments: payload.attachments.map(a => ({...a,createdAt:new Date(a.createdAt)})),
  };
}
