import { z } from 'zod';

const uuid = z.string().uuid();
const optionalId = uuid.nullable();
const comment = z.object({ id: uuid, taskId: uuid, authorId: uuid, text: z.string().max(10000), createdAt: z.string().datetime() }).strict();
const attachment = z.object({ id: uuid, taskId: uuid, fileName: z.string().max(255), fileType: z.string().max(120), data: z.string().max(1000000), createdAt: z.string().datetime() }).strict();
export const taskPayloadV1 = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1).max(300),
  description: z.string().max(20000),
  status: z.enum(['created','assigned','in_progress','checked','completed','rejected']),
  priority: z.enum(['low','medium','high','critical']),
  assignedTo: optionalId,
  createdBy: uuid,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  dueDate: z.string().datetime().nullable(),
  techCardId: optionalId,
  stage: z.enum(['storage','slurry','coating','calendaring','cutting','sorting','assembly','electrolyte','electrolyte-705','walzing','formation']).nullable(),
  workshopId: z.string().max(120).nullable(),
  comments: z.array(comment).max(1000),
  attachments: z.array(attachment).max(30),
}).strict();
export type TaskPayloadV1 = z.infer<typeof taskPayloadV1>;
