// Применение входящегоSyncPacket к локальной базе (офлайн-синхронизация).
// Конфликты: побеждает более свежий ts; forced-пакеты master'а применяются безусловно.

import { db } from '../core/db';
import { SyncPacket, Task, JournalEntry, StageComment, User, MixComponent, MixRecipe, MixBatch, CoatRun, CoatingMixSnapshot } from '../core/types';

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
      case 'mix-batch': {
        // Журнал замеса: slave присылает результат master'у.
        // Побеждает более свежий updatedAt; forced (от master) — безусловно.
        const b = p.payload as MixBatch;
        const existing = await db.mixBatches.get(b.id);
        if (existing && !p.forced && existing.updatedAt >= b.updatedAt) {
          return { ok: true, message: `Замес «${b.recipeName}» уже новее — пропущено` };
        }
        await db.mixBatches.put(b);
        return { ok: true, message: `Журнал замеса получен: «${b.recipeName}» (${p.forced ? 'принудительно' : 'slave → master'})` };
      }
      case 'mix-component': {
        const c = p.payload as MixComponent;
        const existing = await db.mixComponents.get(c.id);
        if (existing && !p.forced && existing.updatedAt >= c.updatedAt) {
          return { ok: true, message: `Компонент «${c.name}» уже новее — пропущено` };
        }
        await db.mixComponents.put(c);
        return { ok: true, message: `Компонент обновлён: ${c.name}` };
      }
      case 'mix-recipe': {
        const r = p.payload as MixRecipe;
        const existing = await db.mixRecipes.get(r.id);
        if (existing && !p.forced && existing.updatedAt >= r.updatedAt) {
          return { ok: true, message: `Стандартный замес «${r.name}» уже новее — пропущено` };
        }
        await db.mixRecipes.put(r);
        return { ok: true, message: `Стандартный замес обновлён: ${r.name}${p.forced ? ' (forced master→slave)' : ''}` };
      }
      case 'coating-mix': {
        // Данные замеса → участку нанесения: кладём в «входящие замесы» комнаты намазки.
        const snap = p.payload as CoatingMixSnapshot;
        await db.coatIncomingMixes.put(snap);
        return { ok: true, message: `Данные замеса приняты: «${snap?.recipeName}» (вязкость ${snap?.viscosity ?? '—'} сП)` };
      }
      case 'coat-run': {
        // Журнал нанесения: slave → master. Свежесть по updatedAt; forced — безусловно.
        const r = p.payload as CoatRun;
        if (!Array.isArray(r.segLengthsM)) r.segLengthsM = [];
        if (!Array.isArray(r.ovenTempsC)) r.ovenTempsC = new Array(6).fill(0);
        const existing = await db.coatRuns.get(r.id);
        if (existing && !p.forced && existing.updatedAt >= r.updatedAt) {
          return { ok: true, message: `Запись нанесения от ${new Date(r.createdAt).toLocaleDateString('ru-RU')} уже новее — пропущено` };
        }
        await db.coatRuns.put(r);
        return { ok: true, message: `Журнал нанесения получен (${p.forced ? 'принудительно' : 'slave → master'})` };
      }
      case 'forced-push': {
        // Принудительная запись от master: применяем payload без проверки свежести
        const payload = p.payload as Task | User | MixRecipe | MixComponent | MixBatch | CoatRun;
        if ('login' in payload) {
          await db.users.put(payload as User);
          return { ok: true, message: `(forced) пользователь обновлён: ${(payload as User).login}` };
        }
        if ('segLengthsM' in payload && 'ovenTempsC' in payload) {
          await db.coatRuns.put(payload as CoatRun);
          return { ok: true, message: '(forced) журнал нанесения применён' };
        }
        if ('lines' in payload && 'dryMassKg' in payload) {
          await db.mixRecipes.put(payload as MixRecipe);
          return { ok: true, message: `(forced) стандартный замес применён: ${(payload as MixRecipe).name}` };
        }
        if ('kind' in payload) {
          await db.mixComponents.put(payload as MixComponent);
          return { ok: true, message: `(forced) компонент применён: ${(payload as MixComponent).name}` };
        }
        if ('weighings' in payload) {
          await db.mixBatches.put(payload as MixBatch);
          return { ok: true, message: `(forced) журнал замеса применён: ${(payload as MixBatch).recipeName}` };
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
