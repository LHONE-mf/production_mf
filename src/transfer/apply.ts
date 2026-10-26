// Применение входящегоSyncPacket к локальной базе (офлайн-синхронизация).
// Конфликты: побеждает более свежий ts; forced-пакеты master'а применяются безусловно.

import { db } from '../core/db';
import { SyncPacket, Task, JournalEntry, StageComment, User, MixComponent, MixRecipe, MixBatch, CoatRun, CoatingMixSnapshot, RollToTechPacket, CalenderRun, ChatMessage, CuttingIncoming, CutRun, SortSpec, SortRun, DefectEntry, AssemblyRun, ElectrolyteIncoming, FillRun, WalzingIncoming, WalzRun, FormationIncoming, FormationRun } from '../core/types';

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
      case 'roll-spec': {
        // Рулон с намазки → технологу (master) → каландрирование.
        // Сохраняем спецификацию рулона и (если пришли) параметры прокатки от технолога.
        const rp = p.payload as RollToTechPacket;
        if (!rp?.roll || !Array.isArray(rp.roll.segLengthsM)) {
          return { ok: false, message: 'Пакет рулона повреждён (нет спецификации)' };
        }
        await db.rollSpecs.put(rp.roll);
        let msg = `Рулон принят на каландрирование: «${rp.roll.mixName}»`;
        if (rp.calenderParams) {
          // параметры от технолога (master) — записываем в задание прокатки на slave
          const existing = await db.calenderRuns.get(rp.roll.id);
          if (existing) {
            await db.calenderRuns.put({ ...existing, params: rp.calenderParams, updatedAt: Math.max(Date.now(), existing.updatedAt + 1) });
          } else {
            await db.calenderRuns.add({
              id: rp.roll.id, rollId: rp.roll.id, params: rp.calenderParams,
              gapsMm: [], hasDefects: false, workerId: p.from, createdAt: Date.now(), updatedAt: Date.now(),
            });
          }
          msg += ` · параметры прокатки заданы технологом (цель ${rp.calenderParams.targetThicknessUm ?? '—'} мкм)`;
        } else {
          msg += ' · ждёт параметров прокатки от технолога';
        }
        return { ok: true, message: msg };
      }
      case 'calender-result': {
        // Результат прокатки → нарезка / master. Свежесть по updatedAt; forced — безусловно.
        const c = p.payload as CalenderRun;
        if (!Array.isArray(c.gapsMm)) c.gapsMm = [];
        const existing = await db.calenderRuns.get(c.id);
        if (existing && !p.forced && existing.updatedAt >= c.updatedAt) {
          return { ok: true, message: `Результат прокатки от ${new Date(c.createdAt).toLocaleDateString('ru-RU')} уже новее — пропущено` };
        }
        await db.calenderRuns.put(c);
        return { ok: true, message: `Результат прокатки получен${c.hasDefects ? ' ⚠ с дефектами' : ''} → доступен для нарезки` };
      }
      case 'cutting-roll': {
        // Рулон + задание технолога → нарезка. Сохраняем входящий рулон целиком.
        const ci = p.payload as CuttingIncoming;
        if (!ci?.roll || !ci.electrodeType) {
          return { ok: false, message: 'Пакет нарезки повреждён (нет рулона или типа электродов)' };
        }
        const prev = await db.cuttingRolls.get(ci.id);
        if (prev && !p.forced && prev.createdAt >= ci.createdAt) {
          return { ok: true, message: `Рулон «${ci.roll.mixName}» уже принят ранее — пропущено` };
        }
        await db.cuttingRolls.put(ci);
        const typeLabel = ci.electrodeType === 'strip' ? 'полосы (цилиндрические)' : 'призматические пластины';
        return { ok: true, message: `📥 На нарезку: «${ci.roll.mixName}» · ${typeLabel}${ci.electrodeLengthMm ? ` · L=${ci.electrodeLengthMm} мм` : ''}` };
      }
      case 'cut-run': {
        // Журнал нарезки → сортировка / master. Свежесть по updatedAt; forced — безусловно.
        const cr = p.payload as CutRun;
        if (!cr.id || typeof cr.goodCount !== 'number') {
          return { ok: false, message: 'Запись нарезки повреждена' };
        }
        const existing = await db.cuttingRuns.get(cr.id);
        if (existing && !p.forced && existing.updatedAt >= cr.updatedAt) {
          return { ok: true, message: `Партия нарезки от ${new Date(cr.createdAt).toLocaleDateString('ru-RU')} уже новее — пропущено` };
        }
        await db.cuttingRuns.put(cr);
        return { ok: true, message: `✂️ Партия нарезки получена: годных ${cr.goodCount}, дефектных ${cr.defectCount} → на сортировку` };
      }
      case 'sort-spec': {
        // Спецификация сортировки от технолога (параметры из КД) → комната сортировки.
        const ss = p.payload as SortSpec;
        if (!ss.id || !ss.batchName || !Array.isArray(ss.categories) || ss.categories.length === 0) {
          return { ok: false, message: 'Спецификация сортировки повреждена (нет партии или категорий)' };
        }
        const prev = await db.sortSpecs.get(ss.id);
        if (prev && !p.forced && prev.updatedAt >= ss.updatedAt) {
          return { ok: true, message: `Спецификация «${ss.batchName}» уже новее — пропущено` };
        }
        await db.sortSpecs.put(ss);
        return { ok: true, message: `📐 Технолог задал сортировку «${ss.batchName}»: ${ss.parameterName}, категорий: ${ss.categories.length}` };
      }
      case 'sort-run': {
        // Результат сортировки партии → мастер/технолог (master). Свежесть по updatedAt; forced — безусловно.
        const sr = p.payload as SortRun;
        if (!sr.id || !Array.isArray(sr.buckets)) {
          return { ok: false, message: 'Запись сортировки повреждена' };
        }
        const existing = await db.sortRuns.get(sr.id);
        if (existing && !p.forced && existing.updatedAt >= sr.updatedAt) {
          return { ok: true, message: `Сортировка партии «${sr.batchName}» уже новее — пропущено` };
        }
        await db.sortRuns.put(sr);
        return { ok: true, message: `🔀 Сортировка «${sr.batchName}» принята: категорий ${sr.buckets.length}, отбраковано ${sr.rejected}` };
      }
      case 'defect-entry': {
        // Запись реестра дефектов электродов (ведёт технолог/master, подгружается на сортировке)
        const d = p.payload as DefectEntry;
        if (!d.id || !d.title || !d.severity) return { ok: false, message: 'Запись дефекта повреждена' };
        const prev = await db.defectRegistry.get(d.id);
        if (prev && !p.forced && prev.updatedAt >= d.updatedAt) {
          return { ok: true, message: `Дефект «${d.title}» уже новее — пропущено` };
        }
        await db.defectRegistry.put(d);
        return { ok: true, message: `📋 Реестр дефектов обновлён: ${d.title} (${d.severity === 'critical' ? 'критичный' : 'не критичный'})` };
      }
      case 'assembly-run': {
        // Партия сборки: пришла с сортировки (название партии), идёт по подсекциям.
        // Результат уходит на формовку / всем master-устройствам. Свежесть по updatedAt; forced — безусловно.
        const ar = p.payload as AssemblyRun;
        if (!ar.id || !ar.batchName || !Array.isArray(ar.ops)) {
          return { ok: false, message: 'Партия сборки повреждена' };
        }
        const existing = await db.assemblyRuns.get(ar.id);
        if (existing && !p.forced && existing.updatedAt >= ar.updatedAt) {
          return { ok: true, message: `Сборка «${ar.batchName}» уже новее — пропущено` };
        }
        await db.assemblyRuns.put(ar);
        return { ok: true, message: `🔋 Сборка «${ar.batchName}» принята: операций ${ar.ops.length}, ячеек годных ${ar.cellsOut}` };
      }
      case 'electrolyte-in': {
        // Входящая партия ячеек со сборки в бокс заливки (сухая комната / 7 эт. к.5)
        const ei = p.payload as ElectrolyteIncoming;
        if (!ei.id || !ei.batchName || !ei.box) return { ok: false, message: 'Партия для заливки повреждена' };
        const existing = await db.electrolyteIncoming.get(ei.id);
        if (existing && !p.forced && existing.updatedAt >= ei.updatedAt) {
          return { ok: true, message: `Партия «${ei.batchName}» уже принята в бокс — пропущено` };
        }
        await db.electrolyteIncoming.put(ei);
        return { ok: true, message: `💧 Принято в заливку: «${ei.batchName}», ячеек ${ei.cellsIn}` };
      }
      case 'fill-run': {
        // Результат заливки электролита → master / формирование
        const fr = p.payload as FillRun;
        if (!fr.id || !fr.batchName || !fr.box) return { ok: false, message: 'Запись заливки повреждена' };
        const existing = await db.fillRuns.get(fr.id);
        if (existing && !p.forced && existing.updatedAt >= fr.updatedAt) {
          return { ok: true, message: `Заливка «${fr.batchName}» уже новее — пропущено` };
        }
        await db.fillRuns.put(fr);
        return { ok: true, message: `💧 Заливка «${fr.batchName}» принята: залито ${fr.cellsFilled}, брак ${fr.cellsScrap}` };
      }
      case 'walzing-in': {
        // Залитые ячейки с 7 этажа/к.5 → входящие партии на вальцовку
        const wi = p.payload as WalzingIncoming;
        if (!wi.id || !wi.batchName) return { ok: false, message: 'Партия на вальцовку повреждена' };
        const existing = await db.walzingIncoming.get(wi.id);
        if (existing && !p.forced && existing.updatedAt >= wi.updatedAt) {
          return { ok: true, message: `Партия «${wi.batchName}» на вальцовке уже новее — пропущено` };
        }
        await db.walzingIncoming.put(wi);
        return { ok: true, message: `🎡 На вальцовку принята партия «${wi.batchName}»: ${wi.cellsIn} яч.` };
      }
      case 'walz-run': {
        // Результат вальцовки → master / формирование
        const wr = p.payload as WalzRun;
        if (!wr.id || !wr.batchName) return { ok: false, message: 'Запись вальцовки повреждена' };
        const existing = await db.walzRuns.get(wr.id);
        if (existing && !p.forced && existing.updatedAt >= wr.updatedAt) {
          return { ok: true, message: `Вальцовка «${wr.batchName}» уже новее — пропущено` };
        }
        await db.walzRuns.put(wr);
        return { ok: true, message: `🎡 Вальцовка «${wr.batchName}» принята: годных ${wr.cellsOut}, брак ${wr.cellsScrap}` };
      }
      case 'formation-in': {
        // Партия на формировку (из сухой комнаты заливки или с вальцовки), с номерами АК
        const fi = p.payload as FormationIncoming;
        if (!fi.id || !fi.batchName) return { ok: false, message: 'Партия на формировку повреждена' };
        const existing = await db.formationIncoming.get(fi.id);
        if (existing && !p.forced && existing.updatedAt >= fi.updatedAt) {
          return { ok: true, message: `Партия «${fi.batchName}» на формировке уже новее — пропущено` };
        }
        await db.formationIncoming.put(fi);
        return { ok: true, message: `⚡ На формировку принята партия «${fi.batchName}»: ${fi.cellsIn} яч.` };
      }
      case 'formation-run': {
        // Результат формировки → master / старение
        const fr = p.payload as FormationRun;
        if (!fr.id || !fr.batchName) return { ok: false, message: 'Запись формировки повреждена' };
        const existing = await db.formationRuns.get(fr.id);
        if (existing && !p.forced && existing.updatedAt >= fr.updatedAt) {
          return { ok: true, message: `Формировка «${fr.batchName}» уже новее — пропущено` };
        }
        await db.formationRuns.put(fr);
        return { ok: true, message: `⚡ Формировка «${fr.batchName}» принята: годных ${fr.cellsOut}, КЭ ${fr.coulombEfficiencyPct ?? '—'}%` };
      }
      case 'chat': {
        // Меш-чат: id детерминированный (from:ts) — повторная ретрансляция того же
        // сообщения просто обновит ttl и не создаст дубль.
        const m = p.payload as ChatMessage;
        if (!m.id || !m.text) return { ok: false, message: 'Пустое сообщение чата' };
        const existing = await db.chatMessages.get(m.id);
        if (existing) {
          // уже есть — обновим ttl (для дальнейшей ретрансляции), дубликат игнорируем
          await db.chatMessages.put({ ...existing, ttl: Math.max(existing.ttl ?? 0, m.ttl ?? 0) });
          return { ok: true, message: `Чат: дубликат «${m.fromName}» пропущен` };
        }
        await db.chatMessages.put(m);
        return { ok: true, message: `💬 Сообщение от ${m.fromName}` };
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
