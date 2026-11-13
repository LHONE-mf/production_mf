// ============================================================
// КОМНАТА ФОРМИРОВАНИЯ (ЧЦЦ — формовка залитых ячеек).
// Вход: партии из ЗАЛИВКИ В СУХОЙ КОМНАТЕ и с ВАЛЬЦОВКИ (пакет formation-in),
// вместе с партиями мигрируют НОМЕРА АККУМУЛЯТОРОВ (задаются на сборке).
// Журнал формировки: дата начала, режим (ток / напряжение / кол-во циклов),
// кулоновская эффективность, ёмкость 5-го цикла, годные/брак/дефекты.
// Результат уходит на старение/master пакетом formation-run.
// ============================================================
import {hasFormationSource,hasFormationResult,saveFormationResult,validateFormationResult,FORMATION_UNITS} from '../../core/manufacturing/formationResults';
import React, { useRef,useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import {
  StageId, SyncPacket, FormationIncoming, FormationRun,
  serialRangeLabel,
} from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { CommentsSection } from '../_common/CommentsSection';

type Tab = 'incoming' | 'new' | 'journal' | 'comments';

const inputCls =
  'min-h-11 min-w-0 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

const emptyForm = {
  batchName: '', prefix: '', start: '', end: '',
  currentA: '', voltageV: '', cycles: '',
  startDate: '', endDate: '',
  coulombEff: '', capacity5: '',
  equipmentRef:'',measurementBasis:'',cellsIn: '', cellsOut: '', cellsScrap: '', cellsUnknown:'', defects: '', comment: '',
};

export function FormationModule(){const actor=useAuthStore(s=>s.currentUser?.id);return <FormationContent key={actor}/>;}
function FormationContent() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const stage = StageId.FORMATION;
  const [tab, setTab] = useState<Tab>('incoming');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);
  const [form, setForm] = useState(emptyForm);
  const lock=useRef(false),attempt=useRef<FormationRun|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const [takenFrom, setTakenFrom] = useState<FormationIncoming | null>(null);

  const incoming = useLiveQuery(async () => {
    const all = await db.formationIncoming.toArray();
    return all.sort((a, b) => (b.receivedAt ?? '').localeCompare(a.receivedAt ?? ''));
  }, []);
  const runs = useLiveQuery(async () => {
    const all = await db.formationRuns.toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const takeIncoming=(fi:FormationIncoming)=>{
    attempt.current=null;setError('');setOutPacket(null);setForm({...emptyForm,batchName:fi.batchName,prefix:fi.serialRange?.prefix??'',start:fi.serialRange?String(fi.serialRange.start):'',end:fi.serialRange?String(fi.serialRange.end):''});setTakenFrom(fi);setTab('new');
  };
  const packet=(run:FormationRun)=>{if(currentUser)setOutPacket({v:1,type:'formation-run',stage,payload:run,from:currentUser.id,role:currentUser.role,ts:Date.now()});};
  const saveRun=async(sendAfter:boolean)=>{
    if(!currentUser||lock.current)return;lock.current=true;setBusy(true);setError('');
    try{
      if(!attempt.current){
        const value=(raw:string,required=false)=>{
          if(!raw.trim()){if(required)throw new Error('Введите циклы и все количества явно. Пустое значение не считается нулём.');return undefined;}
          const normalized=raw.trim().replace(',','.');if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized))throw new Error('Введите конечное числовое наблюдение в указанных единицах');return Number(normalized);
        };
        let serialRange=takenFrom?.serialRange;
        if(!takenFrom&&[form.prefix,form.start,form.end].some(v=>v.trim())){
          const start=value(form.start,true)!,end=value(form.end,true)!;
          if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start)throw new Error('Введите полный целый диапазон номеров');
          serialRange={prefix:form.prefix.trim()||undefined,start,end};
        }
        const linked=hasFormationSource(takenFrom??undefined),now=new Date().toISOString();
        const draft:FormationRun={id:uuidv4(),sourceLedger:linked?1:undefined,inputSnapshot:linked?takenFrom!:undefined,legacyInputSnapshot:linked?undefined:takenFrom??undefined,batchName:form.batchName.trim(),serialRange,
          mode:{cycles:value(form.cycles,true)!,currentA:value(form.currentA),voltageV:value(form.voltageV)},startDate:form.startDate,endDate:form.endDate||undefined,coulombEfficiencyPct:value(form.coulombEff),capacityCycle5Ah:value(form.capacity5),
          cellsIn:value(form.cellsIn,true)!,cellsOut:value(form.cellsOut,true)!,cellsScrap:value(form.cellsScrap,true)!,cellsUnknown:value(form.cellsUnknown,true)!,equipmentRef:form.equipmentRef.trim()||undefined,measurementBasis:form.measurementBasis.trim()||undefined,measurementUnits:FORMATION_UNITS,
          defects:form.defects.split(',').map(v=>v.trim()).filter(Boolean),comment:form.comment.trim()||undefined,workerId:currentUser.id,recordedRole:currentUser.role,createdAt:now,updatedAt:now};
        validateFormationResult(draft);attempt.current=draft;
      }
      const saved=await saveFormationResult(attempt.current,currentUser.id);setForm(emptyForm);setTakenFrom(null);attempt.current=null;setTab('journal');if(sendAfter)packet(saved);
    }catch(cause){setError(cause instanceof Error?cause.message:'Результат не сохранён');}finally{lock.current=false;setBusy(false);}
  };

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage, authorId: currentUser.id, text: text.trim(), createdAt: new Date(),
    });
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'incoming', label: `📥 С заливки/вальцовки (${(incoming ?? []).length})` },
    { id: 'new', label: '✍️ Новая формовка' },
    { id: 'journal', label: `📒 Журнал (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  const num = (v?: number, unit = '') => (v === undefined || Number.isNaN(v) ? '—' : `${v}${unit}`);

  return (
    <div className="space-y-4">
      <h2 className="text-lg font-bold text-white">⚡ Формирование (ЧЦЦ)</h2>
      <p className="text-xs text-slate-400">
        Номера аккумуляторов приходят вместе с партией (миграция: сборка → заливка → формирование).
        Новые записи — введённые наблюдения, без QA-допуска и назначения режима оборудования.
      </p>

      <div className="flex gap-1 flex-wrap border-b border-slate-800 pb-2">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-t text-xs ${tab === t.id ? 'bg-slate-800 text-white font-semibold' : 'text-slate-400 hover:text-white'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ---- ВХОДЯЩИЕ ПАРТИИ ---- */}
      {tab === 'incoming' && (
        <div className="space-y-2">
          {(incoming ?? []).length === 0 && (
            <div className="text-sm text-slate-500">Пока нет партий. Придут с заливки (сухая комната) или с вальцовки пакетами QR/BLE/текст.</div>
          )}
          {(incoming ?? []).map((fi) => (
            <div key={fi.id} className="bg-slate-800/60 border border-slate-700 rounded p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm text-white font-semibold">{fi.batchName}</div>
                <button disabled={(runs??[]).some(run=>run.inputSnapshot?.id===fi.id||run.legacyInputSnapshot?.id===fi.id)} onClick={() => takeIncoming(fi)}
                  className="text-xs bg-violet-700 hover:bg-violet-600 text-white rounded px-2 py-1">Взять в формовку ▸</button>
              </div>
              <div className="text-xs text-slate-300 mt-1">
                Источник: {fi.sourceBox === 'dry-room' ? '💧 Заливка (сухая комната)' : fi.sourceBox === 'floor7-room5' ? '🏭 Заливка (7 эт./к.5)' : '🎡 Вальцовка'} ·
                {hasFormationSource(fi)?'назначено':'исторически принято'} ячеек: {fi.cellsIn} · №АК: <b>{serialRangeLabel(fi.serialRange)}</b>
              </div>
              {hasFormationSource(fi)&&<p className="text-xs text-amber-200">Задание сохранено; физическая приёмка не подтверждена. Фактически поданное количество записывается явно в наблюдении.</p>}
            </div>
          ))}
        </div>
      )}

      {/* ---- НОВАЯ ФОРМОВКА ---- */}
      {tab === 'new' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-w-3xl">
          {takenFrom && (
            <div className="md:col-span-2 text-xs bg-violet-900/40 border border-violet-700 rounded p-2">
              Партия «{takenFrom.batchName}» взята с {takenFrom.sourceBox === 'dry-room' ? 'заливки в сухой комнате' : takenFrom.sourceBox === 'floor7-room5' ? 'заливки (7 эт.)' : 'вальцовки'};
              источник и номера зафиксированы. Укажите весь фактически поданный вход явно.
            </div>
          )}
          <div><label className={labelCls}>Партия (название)</label>
            <input className={inputCls} aria-label="Партия" disabled={busy||!!attempt.current||!!takenFrom} value={form.batchName} onChange={set('batchName')} placeholder="напр. ПАРТ-2026-041" /></div>
          <div><label className={labelCls}>Номера АК: префикс / нач. / кон.</label>
            <span className="flex gap-1">
              <input className={inputCls + ' w-20'} aria-label="Префикс" disabled={busy||!!attempt.current||!!takenFrom} value={form.prefix} onChange={set('prefix')} placeholder="MF-" />
              <input className={inputCls + ' w-24'} type="number" aria-label="Первый номер" disabled={busy||!!attempt.current||!!takenFrom} value={form.start} onChange={set('start')} placeholder="1001" />
              <input className={inputCls + ' w-24'} type="number" aria-label="Последний номер" disabled={busy||!!attempt.current||!!takenFrom} value={form.end} onChange={set('end')} placeholder="1200" />
            </span></div>

          <div className="md:col-span-2 text-xs font-semibold text-slate-300 pt-1">Записанные наблюдения (не назначение режима)</div>
          <div><label className={labelCls}>Ток, А (наблюдение)</label>
            <input className={inputCls} type="number" step="0.1" aria-label="Ток, А (наблюдение)" disabled={busy||!!attempt.current} value={form.currentA} onChange={set('currentA')} /></div>
          <div><label className={labelCls}>Напряжение, В (наблюдение)</label>
            <input className={inputCls} type="number" step="0.01" aria-label="Напряжение, В (наблюдение)" disabled={busy||!!attempt.current} value={form.voltageV} onChange={set('voltageV')} /></div>
          <div><label className={labelCls}>Количество циклов</label>
            <input className={inputCls} type="number" aria-label="Количество циклов" disabled={busy||!!attempt.current} value={form.cycles} onChange={set('cycles')} /></div>

          <div><label className={labelCls}>Дата начала формировки</label>
            <input className={inputCls} type="date" aria-label="Дата начала формировки" disabled={busy||!!attempt.current} value={form.startDate} onChange={set('startDate')} /></div>
          <div><label className={labelCls}>Дата окончания (необязательно)</label>
            <input className={inputCls} type="date" aria-label="Дата окончания" disabled={busy||!!attempt.current} value={form.endDate} onChange={set('endDate')} /></div>

          <div><label className={labelCls}>Кулоновская эффективность, %</label>
            <input className={inputCls} type="number" step="0.1" aria-label="Кулоновская эффективность, %" disabled={busy||!!attempt.current} value={form.coulombEff} onChange={set('coulombEff')} /></div>
          <div><label className={labelCls}>Ёмкость 5-го цикла, А·ч</label>
            <input className={inputCls} type="number" step="0.01" aria-label="Ёмкость 5-го цикла, А·ч" disabled={busy||!!attempt.current} value={form.capacity5} onChange={set('capacity5')} /></div>

          <div><label className={labelCls}>Подано ячеек</label>
            <input className={inputCls} type="number" aria-label="Подано ячеек" disabled={busy||!!attempt.current} value={form.cellsIn} onChange={set('cellsIn')} /></div>
          <div><label className={labelCls}>Обработано (без QA)</label>
            <input className={inputCls} type="number" aria-label="Обработано (без QA)" disabled={busy||!!attempt.current} value={form.cellsOut} onChange={set('cellsOut')} /></div>
          <div><label className={labelCls}>Отклонено</label>
            <input className={inputCls} type="number" aria-label="Отклонено" disabled={busy||!!attempt.current} value={form.cellsScrap} onChange={set('cellsScrap')} /></div>
          <div><label className={labelCls}>Не определено</label><input disabled={busy||!!attempt.current} aria-label="Не определено" className={inputCls} inputMode="numeric" value={form.cellsUnknown} onChange={set('cellsUnknown')}/></div>
          <div><label className={labelCls}>Оборудование / канал (если известно)</label><input disabled={busy||!!attempt.current} aria-label="Оборудование / канал" className={inputCls} value={form.equipmentRef} onChange={set('equipmentRef')}/></div>
          <div className="md:col-span-2"><label className={labelCls}>Основание наблюдений (фаза, способ измерений)</label><input disabled={busy||!!attempt.current} aria-label="Основание наблюдений" className={inputCls} value={form.measurementBasis} onChange={set('measurementBasis')} maxLength={1000}/></div>
          <p className="md:col-span-2 text-xs text-amber-200">Подано = обработано + отклонено + не определено, весь источник. Пустые измерения неизвестны; эффективность не рассчитывается. Запись формирования не подтверждает итоговый QC или выпуск продукции.</p>
          <div><label className={labelCls}>Дефекты (через запятую)</label>
            <input className={inputCls} aria-label="Дефекты" disabled={busy||!!attempt.current} value={form.defects} onChange={set('defects')} placeholder="вздутие, недобор ёмкости" /></div>
          <div className="md:col-span-2"><label className={labelCls}>Комментарий</label>
            <input className={inputCls} aria-label="Комментарий" disabled={busy||!!attempt.current} value={form.comment} onChange={set('comment')} /></div>

          {error&&<p role="alert" className="md:col-span-2 text-red-300 text-sm">{error}</p>}
          <div className="md:col-span-2 flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => void saveRun(false)}
              className="px-4 py-2 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white">💾 Сохранить в журнал</button>
            <button disabled={busy} onClick={() => void saveRun(true)}
              className="px-4 py-2 bg-emerald-700 hover:bg-emerald-600 rounded text-sm text-white">💾 И отправить (QR/BLE/текст)</button>
          </div>
          {error&&attempt.current&&<button disabled={busy} className="min-h-11 bg-slate-700 text-white px-3 rounded" onClick={()=>{attempt.current=null;setError('');}}>Изменить незаписанный черновик</button>}
        </div>
      )}

      {/* ---- ЖУРНАЛ ---- */}
      {tab === 'journal' && (
        <div className="space-y-2">
          {(runs ?? []).length === 0 && <div className="text-sm text-slate-500">Журнал пуст.</div>}
          {(runs ?? []).map((r) => (
            <div key={r.id} className="bg-slate-800/60 border border-slate-700 rounded p-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-sm text-white font-semibold">{r.batchName}</div>
                <div className="flex gap-1.5">
                  <button onClick={() => packet(r)}
                    className="text-xs bg-cyan-800 hover:bg-cyan-700 text-white rounded px-2 py-1">Передать ▸</button>
                </div>
              </div>
              <div className="text-xs text-slate-300 mt-1">
                №АК: <b>{serialRangeLabel(r.serialRange)}</b> · начало {r.startDate}{r.endDate ? ` → ${r.endDate}` : ''} ·
                {hasFormationResult(r)?'наблюдения':'исторический режим'}: {num(r.mode.currentA, ' А')} / {num(r.mode.voltageV, ' В')} / {r.mode.cycles} цикл.
              </div>
              <div className="text-xs text-slate-300">
                КЭ: {num(r.coulombEfficiencyPct, ' %')} · ёмкость 5-го цикла: {num(r.capacityCycle5Ah, ' А·ч')} ·
                подано {r.cellsIn}, обработано (без QA) {r.cellsOut}, отклонено {r.cellsScrap}, не определено {r.cellsUnknown??'—'}
                {r.defects.length > 0 && <> · дефекты: {r.defects.join(', ')}</>}
              </div>
              {hasFormationResult(r)&&<p className="text-xs text-slate-400 break-all">Источник {r.inputSnapshot?.id} · автор {r.workerId} · оборудование {r.equipmentRef??'не указано'} · основание: {r.measurementBasis}. Итоговый QC и выпуск не подтверждены.</p>}
              <p className="text-[11px] text-slate-500">Записано {new Date(r.createdAt).toLocaleString('ru-RU')}</p>
              {r.comment && <div className="text-xs text-slate-400 mt-1 italic">{r.comment}</div>}
            </div>
          ))}
        </div>
      )}

      {/* ---- КОММЕНТАРИИ ---- */}
      {tab === 'comments' && (
        <CommentsSection stage={stage} onAdd={addComment} />
      )}

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}

