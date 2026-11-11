// Комната «Вальцовка» — обжим (вальцевание) залитых цилиндрических ячеек.
// Расположена ПОСЛЕ заливки на 7 этаже (к.5): партии приходят пакетом
// walzing-in, результат уходит на формирование/master пакетом walz-run.
// Вкладки: 📥 партии с заливки / ✍️ новая вальцовка / 📒 журнал / 💬 комментарии.
// Параметры станка — первичная структура, будет расширена по описанию процесса.

import {hasWalzingSource,hasWalzingResult,saveWalzingResult,validateWalzingResult,WALZING_UNITS} from '../../core/manufacturing/walzingResults';
import React, { useRef,useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useLiveQuery } from 'dexie-react-hooks';
import { WalzingIncoming, WalzRun, FormationIncoming, SyncPacket, StageId, UserRole } from '../../core/types';
import { db } from '../../core/db';
import { useAuthStore } from '../../core/store/authStore';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { CommentsSection } from '../_common/CommentsSection';

const inputCls =
  'min-h-11 min-w-0 w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

type Tab = 'incoming' | 'new' | 'journal' | 'comments';

export function WalzingRoom(){const actor=useAuthStore(s=>s.currentUser?.id);return <WalzingRoomContent key={actor}/>;}
function WalzingRoomContent() {
  const stage = StageId.WALZING;
  const currentUser = useAuthStore((s) => s.currentUser);
  const isMaster = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('incoming');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);

  // Входящие партии залитых ячеек (из бокса 7 эт./к.5)
  const incoming = useLiveQuery(async () => {
    const all = await db.walzingIncoming.toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, []);
  // Журнал вальцовки (свежие сверху)
  const runs = useLiveQuery(async () => {
    const all = await db.walzRuns.toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, []);

  // ------- форма записи вальцовки -------
  const emptyForm = {
    batchName: '', machineNo: '', incomingDiameter: '', finalDiameter: '',
    passes: '', pressureKgf: '', speedRpm: '', temperatureC: '',
    cellsIn: '', cellsOut: '', cellsScrap: '', cellsUnknown:'', defects: '', comment: '',
  };
  const [form, setForm] = useState(emptyForm);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const [selected,setSelected]=useState<WalzingIncoming|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const lock=useRef(false),attempt=useRef<WalzRun|null>(null);
  const takeIncoming=(wi:WalzingIncoming)=>{
    attempt.current=null;setError('');setForm({...emptyForm,batchName:wi.batchName});setSelected(wi);setOutPacket(null);setTab('new');
  };
  const packet=(run:WalzRun)=>{if(currentUser)setOutPacket({v:1,type:'walz-run',stage,payload:run,from:currentUser.id,role:currentUser.role,ts:Date.now()});};
  const saveRun=async(sendAfter:boolean)=>{
    if(!currentUser||lock.current)return;lock.current=true;setBusy(true);setError('');
    try{
      if(!attempt.current){
        const value=(raw:string,required=false)=>{
          if(!raw.trim()){if(required)throw new Error('Введите все количества явно. Пустое значение не считается нулём.');return undefined;}
          const normalized=raw.trim().replace(',','.');if(!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized))throw new Error('Введите конечное числовое измерение в указанных единицах');return Number(normalized);
        };
        const now=new Date().toISOString(),linked=hasWalzingSource(selected??undefined);
        const draft:WalzRun={id:uuidv4(),batchName:form.batchName.trim(),sourceLedger:linked?1:undefined,inputSnapshot:linked?selected!:undefined,legacyInputSnapshot:linked?undefined:selected??undefined,serialRange:selected?.serialRange,
          machineNo:form.machineNo.trim()||undefined,incomingDiameter:value(form.incomingDiameter),finalDiameter:value(form.finalDiameter),passes:value(form.passes),pressureKgf:value(form.pressureKgf),speedRpm:value(form.speedRpm),temperatureC:value(form.temperatureC),
          cellsIn:value(form.cellsIn,true)!,cellsOut:value(form.cellsOut,true)!,cellsScrap:value(form.cellsScrap,true)!,cellsUnknown:value(form.cellsUnknown,true)!,measurementUnits:WALZING_UNITS,
          defects:form.defects.split(',').map(v=>v.trim()).filter(Boolean),comment:form.comment.trim()||undefined,workerId:currentUser.id,recordedRole:currentUser.role,createdAt:now,updatedAt:now};
        validateWalzingResult(draft);attempt.current=draft;
      }
      const saved=await saveWalzingResult(attempt.current,currentUser.id);setForm(emptyForm);setSelected(null);attempt.current=null;setTab('journal');if(sendAfter)packet(saved);
    }catch(cause){setError(cause instanceof Error?cause.message:'Результат не сохранён');}finally{lock.current=false;setBusy(false);}
  };

  const num = (v?: number, unit = '') => (v === undefined || Number.isNaN(v) ? '—' : `${v}${unit}`);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'incoming', label: `📥 С заливки (${(incoming ?? []).length})` },
    { id: 'new', label: '✍️ Новая вальцовка' },
    { id: 'journal', label: `📒 Журнал (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-2xl">🎡</span>
        <h2 className="text-white font-semibold">Вальцовка (обжим залитых ячеек)</h2>
      </div>
      <p className="text-xs text-slate-400">
        Пост после заливки на 7 этаже (к.5). Ячейки обжимаются на вальцовочном станке
        до итогового диаметра и передаются на формирование.
      </p>

      <div className="flex flex-wrap gap-1">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`text-xs rounded-lg px-3 py-1.5 ${tab === t.id ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'incoming' && (
        <div className="grid gap-2">
          {(incoming ?? []).length === 0 && (
            <p className="text-slate-500 text-sm">
              Пока нет партий с заливки. Они приходят пакетом «walzing-in» (Bluetooth/QR/текст)
              из бокса «Заливка (7 эт. / к.5)» — кнопка «🎡 На вальцовку ▸» в журнале заливки.
            </p>
          )}
          {(incoming??[]).map((wi) => (
            <div key={wi.id} className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 text-sm space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-white font-medium">{wi.batchName}</span>
                <button disabled={(runs??[]).some(run=>run.inputSnapshot?.id===wi.id)} onClick={() => takeIncoming(wi)}
                  className="text-xs bg-amber-700 hover:bg-amber-600 text-white rounded px-2 py-1">Взять в работу ▸</button>
              </div>
              <div className="text-xs text-slate-300">
                {hasWalzingSource(wi)?'назначено':'исторически принято'} <b className="text-emerald-300">{wi.cellsIn}</b> яч. · {wi.electrolyteName ?? 'электролит не указан'}
              </div>
              <div className="text-[11px] text-slate-500">{wi.receivedAt?new Date(wi.receivedAt).toLocaleString('ru-RU'):'Задание сохранено; физическая приёмка не подтверждена'}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'new' && (
        <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-3">
          {selected&&<p className="text-xs text-slate-300 break-all">Источник: {selected.id} · назначено {selected.cellsIn} ячеек · № {selected.serialRange?.prefix}{selected.serialRange?.start}–{selected.serialRange?.end}. Укажите фактически поданные ячейки явно; запись не является QA-допуском.</p>}
          <fieldset disabled={busy||!!attempt.current} className="space-y-3 min-w-0">
          <div><label className={labelCls}>Партия (название) *</label>
            <input className={inputCls} disabled={!!selected} aria-label="Партия" value={form.batchName} onChange={set('batchName')} placeholder="напр. ЦЦ-21700 партия №3" /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div><label className={labelCls}>Станок №</label>
              <input className={inputCls} aria-label="Станок №" value={form.machineNo} onChange={set('machineNo')} /></div>
            <div><label className={labelCls}>Кол-во проходов</label>
              <input className={inputCls} type="number" aria-label="Кол-во проходов" value={form.passes} onChange={set('passes')} /></div>
            <div><label className={labelCls}>Диаметр до, мм</label>
              <input className={inputCls} type="number" step="0.01" aria-label="Диаметр до, мм" value={form.incomingDiameter} onChange={set('incomingDiameter')} /></div>
            <div><label className={labelCls}>Диаметр после, мм</label>
              <input className={inputCls} type="number" step="0.01" aria-label="Диаметр после, мм" value={form.finalDiameter} onChange={set('finalDiameter')} /></div>
            <div><label className={labelCls}>Усилие обжима, кгс</label>
              <input className={inputCls} type="number" aria-label="Усилие обжима, кгс" value={form.pressureKgf} onChange={set('pressureKgf')} /></div>
            <div><label className={labelCls}>Скорость, об/мин</label>
              <input className={inputCls} type="number" aria-label="Скорость, об/мин" value={form.speedRpm} onChange={set('speedRpm')} /></div>
            <div><label className={labelCls}>Температура, °C</label>
              <input className={inputCls} type="number" aria-label="Температура, °C" value={form.temperatureC} onChange={set('temperatureC')} /></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div><label className={labelCls}>Подано ячеек</label>
              <input className={inputCls} type="number" aria-label="Подано ячеек" value={form.cellsIn} onChange={set('cellsIn')} /></div>
            <div><label className={labelCls}>Обработано (без QA)</label>
              <input className={inputCls} type="number" aria-label="Обработано (без QA)" value={form.cellsOut} onChange={set('cellsOut')} /></div>
            <div><label className={labelCls}>Отклонено</label>
              <input className={inputCls} type="number" aria-label="Отклонено" value={form.cellsScrap} onChange={set('cellsScrap')} /></div>
          </div>
          <div><label className={labelCls}>Не определено</label><input aria-label="Не определено" className={inputCls} inputMode="numeric" value={form.cellsUnknown} onChange={set('cellsUnknown')}/></div>
          <p className="text-xs text-amber-200">Подано = обработано + отклонено + не определено, весь источник целиком. При отклонениях номера обработанной части не определены; передача части диапазона не разрешена. Пустые измерения неизвестны. Калибровка станка не выводится из записи.</p>
          <div><label className={labelCls}>Дефекты (через запятую: разрыв, мятость, недобор диаметра…)</label>
            <input className={inputCls} aria-label="Дефекты" value={form.defects} onChange={set('defects')} /></div>
          <div><label className={labelCls}>Примечание</label>
            <input className={inputCls} aria-label="Примечание" value={form.comment} onChange={set('comment')} /></div>
          </fieldset>
          {error&&<p role="alert" className="text-red-300 text-sm">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button disabled={busy} onClick={() => void saveRun(false)} className="bg-slate-700 hover:bg-slate-600 text-white text-sm rounded-lg px-3 py-2">
              💾 Сохранить в журнал
            </button>
            <button disabled={busy} onClick={() => void saveRun(true)} className="bg-cyan-700 hover:bg-cyan-600 text-white text-sm rounded-lg px-3 py-2">
              💾 Сохранить и передать результат ▸
            </button>
          </div>
          {error&&attempt.current&&<button disabled={busy} className="min-h-11 px-3 bg-slate-700 text-white rounded" onClick={()=>{attempt.current=null;setError('');}}>Изменить незаписанный черновик</button>}
        </div>
      )}

      {tab === 'journal'  && (
        <div className="grid gap-2">
          {(runs ?? []).length === 0 && <p className="text-slate-500 text-sm">Журнал пуст.</p>}
          {(runs??[]).map((r) => (
            <div key={r.id} className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 text-sm space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-white font-medium">{r.batchName}</span>
                {!hasWalzingResult(r)&&<button onClick={() => {
                    if (!currentUser) return;
                    const now = new Date().toISOString();
                    const fi: FormationIncoming = {
                      id: r.id, sourceBox: 'walzing', batchName: r.batchName,
                      serialRange: r.serialRange, cellsIn: r.cellsOut,
                      fromWalzRunId: r.id, receivedAt: now, updatedAt: now,
                    };
                    setOutPacket({ v: 1, type: 'formation-in', stage: StageId.FORMATION, payload: fi, from: currentUser.id, ts: Date.now(), forced: isMaster || undefined });
                  }}
                    className="text-xs bg-violet-800 hover:bg-violet-700 text-white rounded px-2 py-1"
                    title="Отправить партию (с номерами АК) на формирование">⚡ На формовку ▸</button>}
                <button onClick={() => packet(r)}
                  className="text-xs bg-cyan-800 hover:bg-cyan-700 text-white rounded px-2 py-1">Передать ▸</button>
              </div>
              <div className="text-xs text-slate-300">
                станок {r.machineNo ?? '—'} · ⌀ {num(r.incomingDiameter)} → {num(r.finalDiameter, ' мм')} · проходов {num(r.passes)} · усилие {num(r.pressureKgf, ' кгс')} · {num(r.speedRpm, ' об/мин')} · t {num(r.temperatureC, ' °C')}
              </div>
              <div className="text-xs text-slate-300">
                подано {r.cellsIn} · обработано (без QA) <b className="text-emerald-300">{r.cellsOut}</b> · отклонено <b className="text-rose-300">{r.cellsScrap}</b>
              </div>
              {hasWalzingResult(r)&&<p className="text-xs text-slate-400 break-all">Источник заливки {r.inputSnapshot?.fromFillRunId} · автор {r.workerId} · не определено {r.cellsUnknown}. Передача на формирование требует защищённого задания; частичные диапазоны не назначаются.</p>}
              {r.defects.length > 0 && <div className="text-xs text-rose-300">Дефекты: {r.defects.join(', ')}</div>}
              {r.comment && <div className="text-xs text-slate-400">«{r.comment}»</div>}
              <div className="text-[11px] text-slate-500">{new Date(r.createdAt).toLocaleString('ru-RU')}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'comments' && (
        <CommentsSection stage={stage} onAdd={async (text) => {
          if (!currentUser) return;
          await db.stageComments.add({ id: uuidv4(), stage, authorId: currentUser.id, text, createdAt: new Date() } as any);
        }} />
      )}

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}
