import {prepareFillingHandover,hasFillingHandover,fillingStage} from '../../core/manufacturing/fillingHandover';
import {FillingResultForm} from './FillingResultForm';
import {hasFillingResult} from '../../core/manufacturing/fillingResults';
import {prepareWalzingHandover} from '../../core/manufacturing/walzingResults';
import {prepareFormationHandover} from '../../core/manufacturing/formationResults';
import {FillingHandoverCard} from './FillingHandoverCard';
// Комната «Заливка электролита» — ОДНО помещение (боксы).
// Инстанцируется дважды в StageRouter:
//   <FillRoom box="dry-room" />     — бокс сухой комнаты;
//   <FillRoom box="floor7-room5" /> — бокс на 7 этаже, комната 5.
// Вход: партии ячеек со СБОРКИ (assembly-run → кнопка «Отправить в заливку»,
// пакет electrolyte-in). Журнал: FillRun (дозировка, вакуум, давление,
// выдержка, температура, влажность) + дефекты. Результат уходит master'у /
// на формирование пакетом fill-run. Детали помещений будут расширены позже.

import React, { useMemo, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ElectrolyteBox, ElectrolyteIncoming, FillRun, FormationIncoming, SyncPacket, StageId, UserRole,
  WalzingIncoming,
} from '../../core/types';
import { db } from '../../core/db';
import { useAuthStore } from '../../core/store/authStore';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { CommentsSection } from '../_common/CommentsSection';

export const BOX_META: Record<ElectrolyteBox, { title: string; icon: string; stage: StageId }> = {
  'dry-room':      { title: 'Заливка электролита · сухая комната', icon: '💧', stage: StageId.ELECTROLYTE },
  'floor7-room5':  { title: 'Заливка электролита · 7 этаж, к.5',   icon: '🏭', stage: StageId.ELECTROLYTE_705 },
};

interface Props { box: ElectrolyteBox; }

type Tab = 'incoming' | 'new' | 'journal' | 'comments';

export function FillRoom({box}:Props){const actorId=useAuthStore(s=>s.currentUser?.id);return <FillRoomContent key={box+actorId} box={box}/>;}
function FillRoomContent({ box }: Props) {
  const meta = BOX_META[box];
  const currentUser = useAuthStore((s) => s.currentUser);
  const isMaster = !!currentUser && [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('incoming');
  const transferIds=useRef(new Map<string,string>());
  const transferLock=useRef(false);const [transferBusy,setTransferBusy]=useState(false),[transferError,setTransferError]=useState('');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);

  // Входящие партии именно этого помещения
  const incoming = useLiveQuery(
    () => db.electrolyteIncoming.where('box').equals(box).toArray(),
    [box],
  );
  // Журнал заливки этого помещения (свежие сверху)
  const runs = useLiveQuery(async () => {
    const all = await db.fillRuns.where('box').equals(box).toArray();
    return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }, [box]);

  // Ячейки со сборки, ещё не отправленные ни в один бокс заливки
  const assemblyRuns = useLiveQuery(() => db.assemblyRuns.toArray(), []);
  const allIncoming=useLiveQuery(()=>db.electrolyteIncoming.toArray(),[]);
  const notSentYet = useMemo(() => (assemblyRuns??[]).filter(run=>run.cellOutput&&!(allIncoming??[]).some(row=>row.handover?.outputId===run.cellOutput!.id)),[assemblyRuns,allIncoming]);
  const showHandoverPacket=(row:ElectrolyteIncoming)=>{
    if(!currentUser)return;
    setOutPacket({v:1,type:'electrolyte-in',stage:fillingStage(row.box),payload:row,from:currentUser.id,role:currentUser.role,ts:Date.now()});
  };
  const sendToBox=async(arId:string)=>{
    if(!currentUser||transferLock.current)return;transferLock.current=true;setTransferBusy(true);setTransferError('');
    try{
      const source=(assemblyRuns??[]).find(row=>row.id===arId);if(!source)throw new Error('Источник не найден');
      if(!transferIds.current.has(source.id))transferIds.current.set(source.id,uuidv4());
      const row=await prepareFillingHandover(source,box,currentUser.id,transferIds.current.get(source.id)!);showHandoverPacket(row);
    }catch(cause){setTransferError(cause instanceof Error?cause.message:'Передача не сохранена');}
    finally{transferLock.current=false;setTransferBusy(false);}
  };

  const [selected,setSelected]=useState<ElectrolyteIncoming|null>(null);
  const available=(incoming??[]).filter(row=>row.receipt&&hasFillingHandover(row)&&!(runs??[]).some(run=>run.sourceReceipt?.id===row.id||!hasFillingResult(run)&&run.batchName===row.batchName));
  const choose=(row:ElectrolyteIncoming)=>{setSelected(row);setOutPacket(null);setTab('new');};
  const resultPacket=(row:FillRun)=>{
    if(currentUser)setOutPacket({v:1,type:'fill-run',stage:meta.stage,payload:row,from:currentUser.id,role:currentUser.role,ts:Date.now()});
  };
  const saved=(row:FillRun,send:boolean)=>{setSelected(null);setTab('journal');if(send)resultPacket(row);};
  const toWalzing=async(row:FillRun)=>{
    if(!currentUser||transferLock.current)return;transferLock.current=true;setTransferBusy(true);setTransferError('');
    try{const instruction=await prepareWalzingHandover(row,currentUser.id);setOutPacket({v:1,type:'walzing-in',stage:StageId.WALZING,payload:instruction,from:currentUser.id,role:currentUser.role,ts:Date.now()});}
    catch(cause){setTransferError(cause instanceof Error?cause.message:'Задание вальцовки не сохранено');}finally{transferLock.current=false;setTransferBusy(false);}
  };
  const toFormation=async(row:FillRun)=>{
    if(!currentUser||transferLock.current)return;transferLock.current=true;setTransferBusy(true);setTransferError('');
    try{const instruction=await prepareFormationHandover(row,currentUser.id);setOutPacket({v:1,type:'formation-in',stage:StageId.FORMATION,payload:instruction,from:currentUser.id,role:currentUser.role,ts:Date.now()});}
    catch(cause){setTransferError(cause instanceof Error?cause.message:'Задание формирования не сохранено');}finally{transferLock.current=false;setTransferBusy(false);}
  };

  const num = (v?: number, unit = '') => (v === undefined || Number.isNaN(v) ? '—' : `${v}${unit}`);

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'incoming', label: `📥 Передачи со сборки (${(incoming ?? []).length})` },
    { id: 'new', label: '✍️ Новая заливка' },
    { id: 'journal', label: `📒 Журнал (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-2xl">{meta.icon}</span>
        <h2 className="text-white font-semibold">{meta.title}</h2>
      </div>

      {transferError&&tab!=='incoming'&&<p role="alert" className="text-red-300 text-sm">{transferError}</p>}
      <div className="flex flex-wrap gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap ${tab === t.id ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'incoming' && (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">Назначьте весь заявленный выход в этот бокс. Получение пакета не означает приёмку; два бокса — альтернативные назначения, не последовательность.</p>
          {transferError&&<p role="alert" className="text-sm text-red-300">{transferError}</p>}
          {notSentYet.length > 0 && (
            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 space-y-2">
              <h3 className="text-white text-sm font-medium">🔋 Готовы на сборке (ещё не отправлены):</h3>
              {notSentYet.map((ar) => (
                <div key={ar.id} className="flex items-center justify-between gap-2 bg-slate-900 rounded-lg px-3 py-2">
                  <span className="text-slate-200 text-sm truncate">{ar.batchName} · заявлено {ar.cellOutput!.count} яч.</span>
                  <button disabled={transferBusy||!isMaster} onClick={() => void sendToBox(ar.id)}
                    className="min-h-11 shrink-0 text-xs bg-cyan-700 hover:bg-cyan-600 text-white rounded px-2 py-1">
                    Назначить в этот бокс ▸
                  </button>
                </div>
              ))}
            </div>
          )}
          {(incoming ?? []).length === 0 ? (
            <p className="text-slate-500 text-sm">Передач в этот бокс пока нет.</p>
          ) : (
            <div className="grid gap-2">
              {incoming!.map((i) => hasFillingHandover(i)?<div key={i.id} className="space-y-2"><FillingHandoverCard row={i} box={box} actor={currentUser} onPacket={showHandoverPacket}/>{currentUser&&available.some(row=>row.id===i.id)&&<button className="min-h-11 px-3 rounded bg-cyan-700 text-white text-sm" onClick={()=>choose(i)}>Записать результат заливки</button>}</div>:(
                <div key={i.id} className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-white font-medium">{i.batchName}</span>
                    <span className="text-cyan-300">{i.cellsIn} ячеек</span>
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    {i.cellType === 'cylindrical' ? 'цилиндрические' : i.cellType === 'prismatic' ? 'призматические' : 'тип не указан'} · принято {i.receivedAt?new Date(i.receivedAt).toLocaleString('ru-RU'):'время неизвестно'}
                  </div>
                  <p className="mt-2 text-xs text-amber-200">Историческая приёмка без защищённого источника. Запись сохранена; новый результат требует заявления выхода и независимой квитанции.</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'new' && <div className="space-y-3 min-w-0">
        {selected&&currentUser?<FillingResultForm key={selected.id+currentUser.id} source={selected} actor={currentUser} onSaved={saved}/>:<>
          <p className="text-sm text-slate-300">Выберите сохранённую независимую приёмку в этом боксе. Источник и номера не вводятся вручную.</p>
          {available.map(row=><button key={row.id} onClick={()=>choose(row)} className="block min-h-11 w-full rounded bg-cyan-800 p-3 text-left text-white break-all">Записать результат: {row.batchName} · принято {row.cellsIn}</button>)}
          {!available.length&&<p className="text-xs text-slate-400">Нет неиспользованных квитанций. Сначала назначьте выход со сборки и отдельно запишите приёмку.</p>}
        </>}
        {selected&&<button className="min-h-11 px-3 rounded bg-slate-700 text-white text-sm" onClick={()=>setSelected(null)}>Отменить выбор и очистить черновик</button>}
      </div>}

      {tab === 'journal' && (
        <div className="grid gap-2">
          {(runs ?? []).length === 0 && <p className="text-slate-500 text-sm">Журнал пуст.</p>}
          {runs!.map((r) => (
            <div key={r.id} className="bg-slate-800/60 border border-slate-700 rounded-xl p-3 text-sm space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-white font-medium">{r.batchName}</span>
                <div className="flex flex-wrap gap-1">
                  {/* только бокс 7 эт./к.5 передаёт залитые ячейки на вальцовку */}
                  {box === 'floor7-room5' && r.cellsFilled > 0 && (!hasFillingResult(r)||r.cellsScrap===0&&r.cellsUnknown===0&&r.cellType==='cylindrical') && (
                    <button onClick={() => {
                      if (!currentUser) return;
                      if(hasFillingResult(r)){void toWalzing(r);return;}
                      const now = new Date().toISOString();
                      const wi: WalzingIncoming = {
                        id: r.id, batchName: r.batchName, cellType: undefined,
                        serialRange: r.serialRange,
                        cellsIn: r.cellsFilled, electrolyteName: r.electrolyteName,
                        fromFillRunId: r.id, receivedAt: now, updatedAt: now,
                      };
                      setOutPacket({ v: 1, type: 'walzing-in', stage: StageId.WALZING, payload: wi, from: currentUser.id, ts: Date.now(), forced: isMaster || undefined });
                    }}
                      className="text-xs bg-amber-800 hover:bg-amber-700 text-white rounded px-2 py-1"
                      disabled={transferBusy} title="Сохранить задание для вальцовки без подтверждения физической приёмки">🎡 На вальцовку ▸</button>
                  )}
                  {box === 'dry-room' && r.cellsFilled > 0 && (!hasFillingResult(r)||r.cellsScrap===0&&r.cellsUnknown===0) && (
                    <button onClick={() => {
                      if (!currentUser) return;
                      if(hasFillingResult(r)){void toFormation(r);return;}
                      const now = new Date().toISOString();
                      const fi: FormationIncoming = {
                        id: r.id, sourceBox: box, batchName: r.batchName,
                        serialRange: r.serialRange, cellsIn: r.cellsFilled,
                        fromFillRunId: r.id, receivedAt: now, updatedAt: now,
                      };
                      setOutPacket({ v: 1, type: 'formation-in', stage: StageId.FORMATION, payload: fi, from: currentUser.id, ts: Date.now(), forced: isMaster || undefined });
                    }}
                      className="text-xs bg-violet-800 hover:bg-violet-700 text-white rounded px-2 py-1"
                      disabled={transferBusy} title="Сохранить задание формирования без подтверждения физической приёмки">⚡ На формовку ▸</button>
                  )}
                  <button onClick={() => resultPacket(r)}
                    className="text-xs bg-cyan-800 hover:bg-cyan-700 text-white rounded px-2 py-1">Передать ▸</button>
                </div>
              </div>
              <div className="text-xs text-slate-300">
                {r.electrolyteName ?? 'электролит не указан'} · доза {num(r.doseActual)} / {num(r.doseMin, ' мг')} · вакуум {num(r.vacuumKpa, ' кПа')} · давление {num(r.pressureKpa, ' кПа')}
              </div>
              <div className="text-xs text-slate-300">
                выдержка {num(r.dwellMin, ' мин')} · t {num(r.temperatureC, ' °C')} · влажн. {num(r.humidityPpm)} {hasFillingResult(r)?'ppm':'(единица старой записи не подтверждена)'} · залито (без QA) <b className="text-emerald-300">{r.cellsFilled}</b> · отклонено <b className="text-rose-300">{r.cellsScrap}</b>
              </div>
              {hasFillingResult(r)&&<div className="text-xs text-slate-300 break-all">Подано: {r.cellsIn} · Не определено: {r.cellsUnknown} · квитанция {r.sourceReceipt?.receipt?.id} · автор {r.workerId} · {r.machineNo??'оборудование не указано'}<p>Основание измерений: {r.measurementBasis}</p>{(r.cellsScrap!==0||r.cellsUnknown!==0)&&<p className="text-amber-200">Номера залитой части не определены. Передача частичного диапазона заблокирована.</p>}</div>}
              {r.defects.length > 0 && <div className="text-xs text-rose-300">Дефекты: {r.defects.join(', ')}</div>}
              {r.comment && <div className="text-xs text-slate-400">«{r.comment}»</div>}
              <div className="text-[11px] text-slate-500">{new Date(r.createdAt).toLocaleString('ru-RU')}</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'comments' && (
        <CommentsSection stage={meta.stage} onAdd={async (text) => {
          if (!currentUser) return;
          await db.stageComments.add({ id: uuidv4(), stage: meta.stage, authorId: currentUser.id, text, createdAt: new Date() } as any);
        }} />
      )}

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}
