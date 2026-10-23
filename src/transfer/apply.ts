// Применение входящегоSyncPacket к локальной базе (офлайн-синхронизация).
// Конфликты: побеждает более свежий ts; forced-пакеты master'а применяются безусловно.

import { db } from '../core/db';
import { SyncPacket, Task, JournalEntry, StageComment, User } from '../core/types';

export interface ApplyResult {
  ok: boolean;
  message: string;
}

export async function applyPacket(p: SyncPacket): Promise<ApplyResult> {
  try {
    switch (p.type) {
      case 'task': {
        const t = p.payload as Task;
        const existing = await db.tasks.get(t.id);
        if (existing && !p.forced && existing.updatedAt >= new Date(t.updatedAt)) {
          return { ok: true, message: `Задание «${t.title}» уже новее — пропущено` };
        }
        await db.tasks.put(t);
        return { ok: true, message: `Задание получено: ${p.forced ? '(принудительно) ' : ''}«${t.title}»` };
      }
      case 'result': {
        const { taskId, status, note } = p.payload as { taskId: string; status: string; note?: string };
        const t = await db.tasks.get(taskId);
        if (!t) return { ok: false, message: 'Задание не найдено на этом устройстве' };
        await db.tasks.put({ ...t, status: status as Task['status'], updatedAt: new Date(p.ts) });
        return { ok: true, message: `Результат принят: «${t.title}» → ${status}` };
      }
      case 'journal': {
        const j = p.payload as JournalEntry;
        if (!(await db.journal.get(j.id))) await db.journal.add(j);
        return { ok: true, message: 'Запись журнала добавлена' };
      }
      case 'comment': {
        const c = p.payload as StageComment;
        if (!(await db.stageComments.get(c.id))) await db.stageComments.add(c);
        return { ok: true, message: 'Комментарий добавлен' };
      }
      case 'user': {
        const u = p.payload as User;
        await db.users.put(u);
        return { ok: true, message: `Пользователь обновлён: ${u.login}` };
      }
      case 'forced-push': {
        // Принудительная запись от master: применяем payload как task/user без проверки свежести
        const payload = p.payload as Task | User;
        if ('login' in payload) {
          await db.users.put(payload as User);
          return { ok: true, message: `(forced) пользователь обновлён: ${(payload as User).login}` };
        }
        await db.tasks.put(payload as Task);
        return { ok: true, message: `(forced) задание применено: ${(payload as Task).title}` };
      }
      default:
        return { ok: false, message: 'Неизвестный тип пакета' };
    }
  } catch (e) {
    return { ok: false, message: 'Ошибка применения пакета: ' + String(e) };
  }
}
