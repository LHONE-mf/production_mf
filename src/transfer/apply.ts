import {receiveCoatingRun} from '../stages/coating/coatingJournal';
import {isStorageJournal,receiveStorageJournal,receiveStorageHistory} from '../core/manufacturing/storageReceipts';
import {receiveFormationIncoming,receiveFormationResult} from '../core/manufacturing/formationResults';
import {receiveSlurryBatch,receiveSlurryHandover} from '../core/manufacturing/slurryBatch';
import {receiveFillingHandover} from '../core/manufacturing/fillingHandover';
import {receiveFillingResult} from '../core/manufacturing/fillingResults';
import {receiveWalzingIncoming,receiveWalzingResult} from '../core/manufacturing/walzingResults';
import {receiveAssemblyIntake} from '../core/manufacturing/assemblyIntake';
import {receiveSortingAllocation} from '../core/manufacturing/sortingAllocation';
import {validateCuttingIncoming,sameCuttingInstruction} from '../core/manufacturing/cuttingInstruction';
// Применение входящегоSyncPacket к локальной базе (офлайн-синхронизация).
// Legacy data may use freshness; protected records reject replacement. Forced and administrative writes are blocked at this boundary.

import { db } from '../core/db';
import { SyncPacket, Task, TaskStatus, JournalEntry, StageComment, MixBatch, CoatRun, CoatingMixSnapshot, RollToTechPacket, CalenderRun, ChatMessage, CuttingIncoming, CutRun, SortRun, DefectEntry, AssemblyRun, ElectrolyteIncoming, FillRun, WalzingIncoming, WalzRun, FormationIncoming, FormationRun, UserRole,StageId } from '../core/types';
import { verifyPacketSig } from '../core/security';
import { validEnvelope, validId, dateEpoch, incomingTask, unsafeLegacyWrite, MAX_PACKET_BYTES } from './packetPolicy';

export interface ApplyResult {
  ok: boolean;
  message: string;
}

/** Legacy signed QR/BLE packets are not authoritative server sync operations.
 * Check ownership and perform the write in the SAME Dexie transaction so a
 * concurrent server pull or queued offline edit cannot be silently overwritten.
 * Forced packets deliberately have no exception to this rule. */
async function applyLocalOnlyTask(
  taskId: string | undefined,
  apply: (existing: Task | undefined) => Promise<ApplyResult>,
): Promise<ApplyResult> {
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, message: 'Некорректный ID задания' };
  }
  return db.transaction('rw', [db.tasks, db.hybridTaskRevisions, db.hybridTaskOutbox], async () => {
    const revision = await db.hybridTaskRevisions.get(taskId);
    const queued = await db.hybridTaskOutbox.where('entityId').equals(taskId).count();
    if (revision || queued) {
      return { ok: false, message: 'Серверное задание нельзя изменять через QR/Bluetooth: используйте защищённую синхронизацию' };
    }
    return apply(await db.tasks.get(taskId));
  });
}

export async function applyPacket(p: SyncPacket): Promise<ApplyResult> {
  try {
    if (!validEnvelope(p) || new TextEncoder().encode(JSON.stringify(p)).length > MAX_PACKET_BYTES) {
      return { ok: false, message: 'Некорректный или слишком большой пакет' };
    }
    const blocked = unsafeLegacyWrite(p);
    if (blocked) return { ok: false, message: blocked };
    if (!(await verifyPacketSig(p))) {
      return { ok: false, message: p.sig ? 'Отклонено: подпись пакета не совпадает с ключом цеха' : 'Отклонено: пакет не подписан (нет sig). Проверьте ключ цеха на обоих устройствах' };
    }

    switch (p.type) {
      case 'task': {
        const t = incomingTask(p.payload);
        if (!t) return { ok: false, message: 'Некорректные поля задания' };
        return applyLocalOnlyTask(t?.id, async existing => {
          if (existing && !Number.isFinite(dateEpoch(existing.updatedAt))) return { ok: false, message: 'Неизвестная дата существующего задания; запись сохранена' };
          if (existing && dateEpoch(existing.updatedAt) >= t.updatedAt.getTime()) {
            return { ok: true, message: `Задание «${t.title}» уже новее — пропущено` };
          }
          await db.tasks.put(t);
          return { ok: true, message: `Задание получено: «${t.title}»` };
        });
      }
      case 'result': {
        const { taskId, status, note } = p.payload as { taskId: string; status: TaskStatus; note?: string };
        if (!validId(taskId) || !Object.values(TaskStatus).includes(status) || (note !== undefined && (typeof note !== 'string' || note.length > 100_000))) return { ok: false, message: 'Некорректный результат задания' };
        return applyLocalOnlyTask(taskId, async t => {
          if (!t) return { ok: false, message: 'Задание не найдено на этом устройстве' };
          if (!Number.isFinite(dateEpoch(t.updatedAt))) return { ok: false, message: 'Неизвестная дата задания; запись сохранена' };
          if (dateEpoch(t.updatedAt) >= p.ts) {
            return { ok: true, message: `Результат по «${t.title}» устарел — пропущен` };
          }
          await db.tasks.put({ ...t, status: status as Task['status'], updatedAt: new Date(p.ts) });
          return { ok: true, message: `Результат принят: «${t.title}» → ${status}` };
        });
      }
      case 'storage-history': {
        await receiveStorageHistory(p.payload,p.stage,p.role,p.from);
        return {ok:true,message:'Поступление и сохранённая история мест приняты атомарно; остаток не подтверждён'};
      }
      case 'journal': {
        const j = p.payload as JournalEntry;
        if(isStorageJournal(j)||isStorageJournal(await db.journal.get(j.id))){await receiveStorageJournal(j,p.stage,p.role,p.from);return {ok:true,message:'Поступление/место записано без замены истории'};}
        if (!(await db.journal.get(j.id))) await db.journal.add(j);
        return { ok: true, message: 'Запись журнала добавлена' };
      }
      case 'comment': {
        const c = p.payload as StageComment;
        if (!(await db.stageComments.get(c.id))) await db.stageComments.add(c);
        return { ok: true, message: 'Комментарий добавлен' };
      }
      case 'mix-batch': {
        // Журнал замеса: slave присылает результат master'у.
        // Protected source snapshots and immutable history are checked below.
        const b = p.payload as MixBatch;
        await receiveSlurryBatch(b,p.stage,p.role,p.from);
        return {ok:true,message:'Замес сохранён без замены исходных навесок и версий'};
      }
      case 'coating-mix': {
        // Данные замеса → участку нанесения: кладём в «входящие замесы» комнаты намазки.
        const snap = p.payload as CoatingMixSnapshot;
        await receiveSlurryHandover(snap,p.stage,p.role,p.from);
        return { ok: true, message: `Данные замеса приняты: «${snap?.recipeName}» (вязкость ${snap?.viscosity ?? '—'} сП)` };
      }
      case 'coat-run': {
        await receiveCoatingRun(p.payload as CoatRun,p.stage,p.role,p.from,!!p.forced);
        return {ok:true,message:'Запись нанесения принята; защищённая история не заменяется'};
      }
      case 'roll-spec': {
        // Рулон с намазки → технологу (master) → каландрирование.
        // A declared roll snapshot cannot supply verified technologist parameters.
        const rp = p.payload as RollToTechPacket;
        if (!rp?.roll || !Array.isArray(rp.roll.segLengthsM)) {
          return { ok: false, message: 'Пакет рулона повреждён (нет спецификации)' };
        }
        return db.transaction('rw', db.rollSpecs, async () => {
          if (!validId(rp.roll.id)) return { ok: false, message: 'Некорректный ID рулона' };
          const existing = await db.rollSpecs.get(rp.roll.id);
          if (existing && JSON.stringify(existing) !== JSON.stringify(rp.roll)) return { ok: false, message: 'Конфликт спецификации рулона: исходная запись сохранена' };
          if (!existing) await db.rollSpecs.add(rp.roll);
          return { ok: true, message: 'Спецификация рулона сохранена как заявленные данные; параметры технолога задаются локально' };
        });
      }
      case 'calender-result': {
        // Legacy declared calender result; freshness by updatedAt.
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
        return await db.transaction('rw',db.cuttingRolls,async()=>{
        // Рулон + задание технолога → нарезка. Сохраняем входящий рулон целиком.
        const ci = p.payload as CuttingIncoming;
        if(ci?.instruction&&![UserRole.MASTER,UserRole.CHIEF,UserRole.TECHNOLOGIST].includes(p.role!))
          return {ok:false,message:'Новое задание нарезки принимает только технолог, мастер или начальник'};
        try{validateCuttingIncoming(ci);}catch{
          return {ok:false,message:'Пакет задания нарезки повреждён или содержит неверный источник'};
        }
        if (!ci?.roll || !ci.electrodeType) {
          return { ok: false, message: 'Пакет нарезки повреждён (нет рулона или типа электродов)' };
        }
        const prev = await db.cuttingRolls.get(ci.id);
        if(prev?.instruction){
          if(sameCuttingInstruction(prev,ci))return {ok:true,message:'Идентичное задание уже сохранено'};
          return {ok:false,message:'Конфликт задания нарезки: исходная запись сохранена'};
        }
        if(prev&&ci.instruction)return {ok:false,message:'Конфликт с существующим входящим рулоном: запись сохранена'};
        if (prev && !p.forced && prev.createdAt >= ci.createdAt) {
          return { ok: true, message: `Рулон «${ci.roll.mixName}» уже принят ранее — пропущено` };
        }
        await db.cuttingRolls.put(ci);
        const typeLabel = ci.electrodeType === 'strip' ? 'полосы (цилиндрические)' : 'призматические пластины';
        return { ok: true, message: `📥 На нарезку: «${ci.roll.mixName}» · ${typeLabel}${ci.electrodeLengthMm ? ` · L=${ci.electrodeLengthMm} мм` : ''}` };
        });
      }
      case 'cut-run': {
        // Legacy declared cutting result; freshness by updatedAt.
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
      case 'sort-run': {
        // Sorting allocations are immutable; signed/forced packets cannot reallocate a cut run.
        const sr = p.payload as SortRun;
        if (!sr.id || !Array.isArray(sr.buckets)) {
          return { ok: false, message: 'Запись сортировки повреждена' };
        }
        await receiveSortingAllocation(sr);
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
        await receiveAssemblyIntake(ar,p.role);
        return { ok: true, message: ar.cellOutput ? `Заявленный выход «${ar.batchName}» сохранён: ${ar.cellOutput.count} ячеек; QA не подтверждено` : ar.intake ? `Приёмка электродов «${ar.batchName}» сохранена; выход ячеек не определён` : `🔋 Сборка «${ar.batchName}» принята: операций ${ar.ops.length}, ячеек годных ${ar.cellsOut}` };
      }
      case 'electrolyte-in': {
        // Входящая партия ячеек со сборки в бокс заливки (сухая комната / 7 эт. к.5)
        const ei = p.payload as ElectrolyteIncoming;
        if (!ei.id || !ei.batchName || !ei.box) return { ok: false, message: 'Партия для заливки повреждена' };
        const accepted=await receiveFillingHandover(ei,p.role,p.from,p.stage);
        return {ok:true,message:accepted.receipt?'Передача и записанная квитанция сохранены':'Передача сохранена; явная приёмка записывается отдельно'};
      }
      case 'fill-run': {
        // Результат заливки электролита → master / формирование
        const fr = p.payload as FillRun;
        if (!fr.id || !fr.batchName || !fr.box) return { ok: false, message: 'Запись заливки повреждена' };
        await receiveFillingResult(fr,p.stage,p.role,p.from);
        return { ok: true, message: `💧 Заливка «${fr.batchName}» принята: залито ${fr.cellsFilled}, брак ${fr.cellsScrap}` };
      }
      case 'walzing-in': {
        // Залитые ячейки с 7 этажа/к.5 → входящие партии на вальцовку
        const wi = p.payload as WalzingIncoming;
        if (!wi.id || !wi.batchName) return { ok: false, message: 'Партия на вальцовку повреждена' };
        await receiveWalzingIncoming(wi,p.stage,p.role,p.from);
        return { ok: true, message: `🎡 Запись входа вальцовки сохранена: «${wi.batchName}», ${wi.cellsIn} яч.; пакет не подтверждает физическую приёмку` };
      }
      case 'walz-run': {
        // Результат вальцовки → master / формирование
        const wr = p.payload as WalzRun;
        if (!wr.id || !wr.batchName) return { ok: false, message: 'Запись вальцовки повреждена' };
        if(p.stage!==StageId.WALZING)return {ok:false,message:'Неверный этап результата вальцовки'};
        await receiveWalzingResult(wr,p.role,p.from);
        return { ok: true, message: `🎡 Вальцовка «${wr.batchName}» записана: обработано ${wr.cellsOut}, отклонено ${wr.cellsScrap}; QA не подтверждено` };
      }
      case 'formation-in': {
        // Партия на формировку (из сухой комнаты заливки или с вальцовки), с номерами АК
        const fi = p.payload as FormationIncoming;
        if (!fi.id || !fi.batchName) return { ok: false, message: 'Партия на формировку повреждена' };
        await receiveFormationIncoming(fi,p.stage,p.role,p.from);
        return {ok:true,message:'Вход формирования сохранён; пакет не подтверждает физическую приёмку'};
      }
      case 'formation-run': {
        const fr=p.payload as FormationRun;
        if(p.stage!==StageId.FORMATION)return {ok:false,message:'Неверный этап результата формирования'};
        await receiveFormationResult(fr,p.role,p.from);
        return {ok:true,message:'Наблюдение формирования сохранено; QA не подтверждено'};
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
      default:
        return { ok: false, message: 'Неизвестный тип пакета' };
    }
  } catch (e) {
    return { ok: false, message: 'Ошибка применения пакета: ' + String(e) };
  }
}
