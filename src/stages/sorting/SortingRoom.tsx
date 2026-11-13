// Комната «Сортировка электродов». Полностью офлайн.
// Вкладки: 📥 Партии с нарезки · 📐 Спецификации технолога (КД) · 🔀 Сортировка ·
//          🗂️ Реестр дефектов · 📒 Журнал · 💬 Комментарии
// Цепочка данных: нарезка → (cut-run: название партии + годные) сюда;
// технолог задаёт параметры сортировки → (sort-spec); оператор разносит электроды
// по категориям (толщина/масса из КД, допустимые дефекты из реестра) →
// результат (sort-run) передаётся мастеру/технологу (master) и дальше на сборку.

import React, { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { listVisibleTasks } from '../../core/sync/visibleTasks';
import {
  CutRun, DefectEntry, ElectrodeShape, SortCategory, SortRun,
  SortSpec, SortingWorkflow, StageId, SyncPacket, UserRole,
} from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { PacketOutModal } from '../_ui/PacketOutModal';
import { SortingWorkflowTab } from './SortingWorkflowTab';

type Tab = 'batches' | 'specs' | 'sort' | 'defects' | 'journal' | 'comments';

const inputCls =
  'w-full min-h-11 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

const shapeLabel = (s: ElectrodeShape) =>
  s === 'strip' ? '📏 Полосы (цилиндрические)' : '▭ Призматические пластины';

export function SortingModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isTechManager = !!currentUser &&
    [UserRole.TECHNOLOGIST, UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);
  const [tab, setTab] = useState<Tab>('batches');
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  const batches = useLiveQuery(async () => {
    const all = await db.cuttingRuns.toArray();
    return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, []);

  const specs = useLiveQuery(async () => {
    const all = await db.sortSpecs.toArray();
    return all.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, []);

  const runs = useLiveQuery(async () => {
    const all = await db.sortRuns.toArray();
    return all.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  }, []);

  const workflows = useLiveQuery(async () => db.sortingWorkflows.toArray(), []);

  const defects = useLiveQuery(async () => {
    const all = await db.defectRegistry.toArray();
    return all.sort((a, b) => (a.severity === b.severity ? a.title.localeCompare(b.title, 'ru') : a.severity === 'critical' ? -1 : 1));
  }, []);

  const tasks = useLiveQuery(async () => {
    const all = await listVisibleTasks();
    return all.filter((t) => t.stage === StageId.SORTING);
  }, []);

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage: StageId.SORTING, authorId: currentUser.id,
      text: text.trim(), createdAt: new Date(),
    });
  };

  const tabs: { id: Tab; label: string }[] = [
    { id: 'batches', label: `📥 Партии с нарезки (${(batches ?? []).length})` },
    { id: 'specs', label: `📐 Спецификации КД (${(specs ?? []).length})` },
    { id: 'sort', label: '🔀 Сортировка' },
    { id: 'defects', label: `🗂️ Реестр дефектов (${(defects ?? []).length})` },
    { id: 'journal', label: `📒 Журнал (${(runs ?? []).length})` },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-lg text-sm ${
              tab === t.id ? 'bg-blue-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'batches' && (
        <BatchesTab
          items={batches ?? []}
          specs={specs ?? []}
          workflows={workflows ?? []}
          runs={runs ?? []}
          onSort={(id) => { setSelectedBatchId(id); setTab('sort'); }}
          onOpenJournal={() => setTab('journal')}
        />
      )}

      {tab === 'specs' && (
        <SpecsTab
          specs={specs ?? []}
          batches={batches ?? []}
          defects={defects ?? []}
          canEdit={isTechManager}
          userId={currentUser?.id ?? ''}
          onSave={async (spec) => {
            const actor=useAuthStore.getState().currentUser;
            if(!actor)throw new Error('Нужен активный локальный профиль');
            await db.transaction('rw',[db.sortSpecs,db.users],async()=>{
              const active=await db.users.get(actor.id);
              if(!active?.isActive||active.role!==actor.role||
                 ![UserRole.TECHNOLOGIST,UserRole.MASTER,UserRole.CHIEF].includes(active.role))
                throw new Error('Нет прав на изменение спецификации');
              const previous=await db.sortSpecs.get(spec.id);
              if(previous && previous.updatedAt!==spec.updatedAt)
                throw new Error('Спецификация изменена другим действием. Отмените правку и откройте актуальную версию.');
              if(!previous && spec.authorId!==actor.id)
                throw new Error('Автор новой спецификации не совпадает с активным профилем');
              await db.sortSpecs.put({...spec,updatedAt:Math.max(Date.now(),(previous?.updatedAt??0)+1)});
            });
          }}
        />
      )}

      <div className={tab === 'sort' ? '' : 'hidden'}>
        <SortingWorkflowTab
          batches={batches ?? []}
          specs={specs ?? []}
          defects={defects ?? []}
          runs={runs ?? []}
          selectedBatchId={selectedBatchId}
          onSelectBatch={setSelectedBatchId}
          workerId={currentUser?.id}
          onComplete={(saved) => {
            if (!currentUser) return;
            setOutPacket({v:1,type:'sort-run',stage:StageId.SORTING,payload:saved,from:currentUser.id,ts:Date.now()});
          }}
        />
      </div>

      {tab === 'defects' && (
        <DefectsTab
          defects={defects ?? []}
          canEdit={isTechManager}
          onSave={async (defect) => {
            const actor=useAuthStore.getState().currentUser;
            if(!actor)throw new Error('Нужен активный локальный профиль');
            await db.transaction('rw',[db.defectRegistry,db.users],async()=>{
              const active=await db.users.get(actor.id);
              if(!active?.isActive||active.role!==actor.role||
                 ![UserRole.TECHNOLOGIST,UserRole.MASTER,UserRole.CHIEF].includes(active.role))
                throw new Error('Нет прав на изменение реестра дефектов');
              const previous=await db.defectRegistry.get(defect.id);
              if(previous && previous.updatedAt!==defect.updatedAt)
                throw new Error('Запись дефекта изменена. Откройте актуальную версию перед повторной правкой.');
              await db.defectRegistry.put({...defect,updatedAt:Math.max(Date.now(),(previous?.updatedAt??0)+1)});
            });
          }}
        />
      )}

      {tab === 'journal' && (
        <JournalTab
          runs={runs ?? []}
          onSend={(run) => {
            setOutPacket({
              v: 1, type: 'sort-run', stage: StageId.SORTING,
              payload: run, from: currentUser!.id, ts: Date.now(),
            });
          }}
        />
      )}

      {tab === 'comments' && <CommentsSection stage={StageId.SORTING} onAdd={addComment} />}

      <details className="bg-slate-800/60 border border-slate-700 rounded-lg p-3">
        <summary className="text-white text-sm font-medium cursor-pointer">📋 Задания этапа ({(tasks ?? []).length})</summary>
        <div className="mt-2 space-y-2">
          {(tasks ?? []).map((t) => (
            <div key={t.id} className="text-xs text-slate-300 border-b border-slate-700/50 pb-1">
              <span className="font-medium text-white">{t.title}</span> · статус: {t.status}
            </div>
          ))}
          {(tasks ?? []).length === 0 && <p className="text-xs text-slate-500">Заданий по этапу пока нет.</p>}
        </div>
      </details>

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}

// ---------- 📥 Партии с нарезки ----------
function BatchesTab({ items, specs, workflows, runs, onSort, onOpenJournal }: {
  items: CutRun[]; specs: SortSpec[]; workflows: SortingWorkflow[]; runs: SortRun[];
  onSort: (id: string) => void; onOpenJournal: () => void;
}) {
  if (items.length === 0) {
    return (
      <div className="bg-slate-800/60 border border-dashed border-slate-700 rounded-lg p-6 text-center">
        <p className="text-slate-400 text-sm">Пока нет партий с участка нарезки.</p>
        <p className="text-slate-500 text-xs mt-2">
          Партия приходит пакетом «cut-run» (QR / текст / Bluetooth) с нарезки: название партии + количество годных.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {items.map((cr) => {
        const spec = specs.find(s=>s.cutRunId===cr.id);
        const workflow = workflows.find(w=>w.cutRunId===cr.id);
        const record = runs.find(r=>r.cutRunId===cr.id || (!r.cutRunId && (r.batchName===cr.incomingId || (spec && r.specId===spec.id))));
        const finished = !!record || !!workflow?.finalizedSortRunId;
        const currentStation = workflow && !workflow.finalizedSortRunId ?
          ['Визуальный контроль','Контроль толщины','Контроль массы'][workflow.stages.length] : null;
        return (
          <div key={cr.id} className="bg-slate-800/70 border border-slate-700 rounded-lg p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-white font-semibold">
                  📦 Партия {cr.incomingId}
                  <span className="ml-2 text-xs font-normal text-slate-400">
                    от {new Date(cr.createdAt).toLocaleString('ru-RU')}
                  </span>
                </div>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-300">
                  <span className="px-2 py-0.5 rounded bg-indigo-900/60 text-indigo-200">{shapeLabel(cr.electrodeType)}</span>
                  {cr.coatingType && <span>Покрытие: <b className="text-white">{cr.coatingType}</b></span>}
                  {cr.electrodeLengthMm ? <span>L: <b className="text-white">{cr.electrodeLengthMm} мм</b></span> : null}
                  <span>Годных: <b className="text-emerald-300">{cr.goodCount}</b> шт</span>
                  <span>Дефектных: <b className="text-rose-300">{cr.defectCount}</b> шт</span>
                </div>
                {cr.defects && <div className="mt-1 text-xs text-amber-300">⚠ {cr.defects}</div>}
                <div className="mt-1 text-xs">
                  {spec
                    ? <span className="text-emerald-300">📐 Спецификация КД получена: «{spec.parameterName}», категорий {spec.categories.length}</span>
                    : <span className="text-amber-200">Спецификация КД отсутствует. Технолог должен создать её локально; импорт через общий QR/Bluetooth ключ заблокирован.</span>}
                </div>
                <div className="mt-2 text-xs space-y-1" aria-label="Статус сортировки">
                  {finished ? <p className="text-emerald-300">✓ Сортировка завершена{record?.sortingWorkflow ? ` · ${record.sortingWorkflow.mode==='grading'?'градация':'годен / брак'}` : ''}</p> :
                    workflow ? <>
                      <p className="text-blue-300">В работе · {workflow.mode==='grading'?'градация':'годен / брак'} · следующая станция: {currentStation}</p>
                      <p className="text-slate-400">Завершено станций: {workflow.stages.length}/3 · прошло дальше: {workflow.stages.length ?
                        workflow.stages[workflow.stages.length-1].passedCount : workflow.cutRunSnapshot.goodCount} шт</p>
                    </> : <p className="text-slate-400">Сортировка ещё не начата</p>}
                </div>
              </div>
              <button
                onClick={() => finished && record ? onOpenJournal() : onSort(cr.id)}
                className="min-h-11 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white shrink-0"
              >
                {finished && record ? '📒 Смотреть журнал' : workflow ? '🔀 Продолжить сортировку' : '🔀 Сортировать'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ---------- 📐 Спецификации технолога (КД) ----------
function SpecsTab({ specs, batches, defects, canEdit, userId, onSave }: {
  specs: SortSpec[]; batches: CutRun[]; defects: DefectEntry[];
  canEdit: boolean; userId: string;
  onSave: (spec: SortSpec) => Promise<void>;
}) {
  const [editing, setEditing] = useState<SortSpec | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const lock=useRef(false);
  async function save(){
    if(lock.current||!editing)return;
    lock.current=true;setBusy(true);setError('');setSuccess('');
    try{
      await onSave(editing);
      setEditing(null);
      setSuccess('Сохранена локально. Передача спецификаций через общий QR/Bluetooth ключ запрещена.');
    }catch(cause){setError(cause instanceof Error?cause.message:'Спецификация не сохранена');}
    finally{lock.current=false;setBusy(false);}
  }

  const blank = (): SortSpec => ({
    id: uuidv4(),
    batchName: batches[0]?.incomingId ?? '',
    cutRunId: batches[0]?.id,
    electrodeType: batches[0]?.electrodeType ?? 'strip',
    coatingType: batches[0]?.coatingType,
    parameterName: 'Толщина электрода',
    unit: 'мкм',
    categories: [{ name: 'Сорт А', criteria: '', minUm: undefined, maxUm: undefined }],
    authorId: userId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  if (editing) {
    return (
      <SpecEditor
        spec={editing}
        isNew={isNew}
        batches={batches}
        defects={defects}
        canEdit={canEdit}
        busy={busy}
        error={error}
        onCancel={() => setEditing(null)}
        onSave={save}
        onChange={setEditing}
      />
    );
  }

  return (
    <div className="space-y-3">
      {success&&<p role="status" className="text-sm text-emerald-200">{success}</p>}
      {canEdit && (
        <button
          onClick={() => {setError('');setSuccess('');setIsNew(true); setEditing(blank()); }}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm text-white"
        >
          ➕ Новая спецификация (КД)
        </button>
      )}
      {specs.length === 0 && (
        <p className="text-slate-500 text-sm">Спецификаций пока нет. Технолог может создать их локально; импорт через общий QR/Bluetooth ключ заблокирован.</p>
      )}
      {specs.map((s) => (
        <div key={s.id} className="bg-slate-800/70 border border-slate-700 rounded-lg p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-white font-semibold">📐 «{s.batchName}» · {s.parameterName} ({s.unit})</div>
              <div className="mt-1 text-xs text-slate-400">
                {shapeLabel(s.electrodeType)}{s.coatingType ? ` · покрытие: ${s.coatingType}` : ''} ·
                обновлена {new Date(s.updatedAt).toLocaleString('ru-RU')}
              </div>
              <div className="mt-2 space-y-1">
                {s.categories.map((c, i) => (
                  <div key={i} className="text-xs text-slate-300 bg-slate-900/60 rounded px-2 py-1">
                    <b className="text-white">{c.name}</b>:
                    {c.minUm != null || c.maxUm != null ? ` ⌀ ${c.minUm ?? '—'}–${c.maxUm ?? '—'} мкм` : ''}
                    {c.minMass != null || c.maxMass != null ? `, масса ${c.minMass ?? '—'}–${c.maxMass ?? '—'} г` : ''}
                    {c.allowedDefects && c.allowedDefects.length > 0 && (
                      <span className="text-amber-300"> · доп. дефекты: {c.allowedDefects
                        .map((id) => defects.find((d) => d.id === id)?.title ?? id).join(', ')}</span>
                    )}
                    {c.criteria && <span className="text-slate-400"> · {c.criteria}</span>}
                  </div>
                ))}
              </div>
              {s.techNotes && <div className="mt-1 text-xs text-emerald-300">📝 {s.techNotes}</div>}
            </div>
            {canEdit && (
              <button
                onClick={() => {setError('');setSuccess('');setIsNew(false); setEditing({ ...s, categories: s.categories.map((c) => ({ ...c })) }); }}
                className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white shrink-0"
              >
                ✏️ Изменить
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function SpecEditor({ spec, isNew, batches, defects, canEdit, busy, error, onCancel, onSave, onChange }: {
  spec: SortSpec; isNew: boolean; batches: CutRun[]; defects: DefectEntry[];
  canEdit: boolean; busy:boolean; error:string; onCancel: () => void; onSave: () => void;
  onChange: (s: SortSpec) => void;
}) {
  const set = (patch: Partial<SortSpec>) => onChange({ ...spec, ...patch });
  const setCat = (i: number, patch: Partial<SortCategory>) =>
    set({ categories: spec.categories.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const num = (v: string) => (v.trim() === '' ? undefined : Number(v.replace(',', '.')));

  return (
    <div className="bg-slate-800/80 border border-slate-600 rounded-lg p-4 space-y-3">
      <h3 className="text-white font-semibold">{isNew ? '➕ Новая спецификация сортировки (КД)' : '✏️ Правка спецификации'}</h3>
      {!canEdit && <p className="text-amber-300 text-xs">Просмотр без редактирования (доступно технологу/мастеру/начальнику).</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Партия (название пришло с нарезки)</label>
          <select
            className={inputCls} value={spec.cutRunId ?? ''}
            disabled={!canEdit}
            onChange={(e) => {
              const b = batches.find((x) => x.id === e.target.value);
              set({ cutRunId: b?.id, batchName: b?.incomingId ?? spec.batchName,
                electrodeType: b?.electrodeType ?? spec.electrodeType, coatingType: b?.coatingType });
            }}
          >
            <option value="">— выберите партию —</option>
            {batches.map((b) => <option key={b.id} value={b.id}>{b.incomingId} (годных {b.goodCount})</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Тип электрода</label>
          <select className={inputCls} value={spec.electrodeType} disabled={!canEdit}
            onChange={(e) => set({ electrodeType: e.target.value as ElectrodeShape })}>
            <option value="strip">📏 Полосы (цилиндрические)</option>
            <option value="prismatic">▭ Призматические</option>
          </select>
        </div>
        <div>
          <label className={labelCls}>Сортируемый параметр (из КД)</label>
          <input className={inputCls} value={spec.parameterName} disabled={!canEdit}
            onChange={(e) => set({ parameterName: e.target.value })} placeholder="напр. Толщина электрода" />
        </div>
        <div>
          <label className={labelCls}>Единица измерения</label>
          <input className={inputCls} value={spec.unit} disabled={!canEdit}
            onChange={(e) => set({ unit: e.target.value })} placeholder="мкм / г / мм…" />
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <label className={labelCls}>Категории (сорта) с допусками толщины и массы</label>
          {canEdit && (
            <button className="text-xs text-blue-300 hover:text-blue-200"
              onClick={() => set({ categories: [...spec.categories, { name: `Сорт ${'БВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ'[spec.categories.length] ?? String(spec.categories.length)}`, criteria: '' }] })}>
              ➕ добавить категорию
            </button>
          )}
        </div>
        <div className="space-y-2">
          {spec.categories.map((c, i) => (
            <div key={i} className="bg-slate-900/70 border border-slate-700 rounded p-2 space-y-2">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <input className={inputCls} value={c.name} disabled={!canEdit} placeholder="Название сорта"
                  onChange={(e) => setCat(i, { name: e.target.value })} />
                <input className={inputCls} type="number" step="any" disabled={!canEdit} placeholder="толщина мин, мкм"
                  value={c.minUm ?? ''} onChange={(e) => setCat(i, { minUm: num(e.target.value) })} />
                <input className={inputCls} type="number" step="any" disabled={!canEdit} placeholder="толщина макс, мкм"
                  value={c.maxUm ?? ''} onChange={(e) => setCat(i, { maxUm: num(e.target.value) })} />
                <div className="flex gap-1">
                  <input className={inputCls} type="number" step="any" disabled={!canEdit} placeholder="масса мин, г"
                    value={c.minMass ?? ''} onChange={(e) => setCat(i, { minMass: num(e.target.value) })} />
                  <input className={inputCls} type="number" step="any" disabled={!canEdit} placeholder="макс"
                    value={c.maxMass ?? ''} onChange={(e) => setCat(i, { maxMass: num(e.target.value) })} />
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input className={inputCls} value={c.criteria ?? ''} disabled={!canEdit} placeholder="критерии из КД (текст)"
                  onChange={(e) => setCat(i, { criteria: e.target.value })} />
                <div className="flex flex-wrap gap-1 items-center">
                  <span className="text-[10px] text-slate-400">доп. дефекты:</span>
                  {defects.filter((d) => d.severity === 'non-critical').map((d) => {
                    const on = (c.allowedDefects ?? []).includes(d.id);
                    return (
                      <button key={d.id} disabled={!canEdit}
                        onClick={() => setCat(i, {
                          allowedDefects: on
                            ? (c.allowedDefects ?? []).filter((x) => x !== d.id)
                            : [...(c.allowedDefects ?? []), d.id],
                        })}
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${on
                          ? 'bg-amber-900/60 border-amber-600 text-amber-200'
                          : 'bg-slate-800 border-slate-700 text-slate-400'}`}
                      >
                        {d.title}
                      </button>
                    );
                  })}
                </div>
              </div>
              {canEdit && spec.categories.length > 1 && (
                <button className="text-xs text-rose-400 hover:text-rose-300"
                  onClick={() => set({ categories: spec.categories.filter((_, j) => j !== i) })}>
                  ✕ удалить категорию
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <div>
        <label className={labelCls}>Примечание технолога</label>
        <textarea className={inputCls} rows={2} value={spec.techNotes ?? ''} disabled={!canEdit}
          onChange={(e) => set({ techNotes: e.target.value })} />
      </div>

      {error&&<p role="alert" className="text-sm text-red-200">{error}</p>}
      <p className="text-xs text-amber-200">Спецификации сохраняются только на этом устройстве. Общий ключ передачи не подтверждает права технолога.</p>
      <div className="flex flex-wrap gap-2">
        <button className="min-h-11 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white disabled:opacity-40"
          disabled={busy||!canEdit || !spec.batchName.trim()}
          onClick={onSave}>{busy?'Сохранение…':'💾 Сохранить локально'}</button>
        <button disabled={busy} className="min-h-11 px-3 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white disabled:opacity-40" onClick={onCancel}>Отмена</button>
      </div>
    </div>
  );
}

// ---------- 🗂️ Реестр дефектов ----------
function DefectsTab({ defects, canEdit, onSave }: {
  defects: DefectEntry[]; canEdit: boolean;
  onSave: (d: DefectEntry) => Promise<void>;
}) {
  const [draft, setDraft] = useState<DefectEntry | null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const lock=useRef(false);
  async function save(){
    if(lock.current||!draft)return;
    lock.current=true;setBusy(true);setError('');setSuccess('');
    try{
      await onSave(draft);
      setDraft(null);
      setSuccess('Сохранено локально. При необходимости передавайте только проверенный сохранённый результат.');
    }catch(cause){setError(cause instanceof Error?cause.message:'Дефект не сохранён');}
    finally{lock.current=false;setBusy(false);}
  }

  const critical = defects.filter((d) => d.severity === 'critical');
  const nonCritical = defects.filter((d) => d.severity === 'non-critical');

  const Group = ({ title, items, tone }: { title: string; items: DefectEntry[]; tone: string }) => (
    <div>
      <h4 className={`text-sm font-semibold mb-2 ${tone}`}>{title} ({items.length})</h4>
      <div className="space-y-2">
        {items.map((d) => (
          <div key={d.id} className="bg-slate-800/70 border border-slate-700 rounded-lg p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-white text-sm font-medium">{d.title}</div>
                {d.description && <div className="text-xs text-slate-400 mt-0.5">{d.description}</div>}
                {d.action && <div className="text-xs text-slate-300 mt-0.5">➜ {d.action}</div>}
              </div>
              {canEdit && (
                <button className="text-xs text-slate-400 hover:text-white"
                  onClick={() => {setError('');setSuccess('');setDraft({ ...d });}}>✏️</button>
              )}
            </div>
          </div>
        ))}
        {items.length === 0 && <p className="text-xs text-slate-500">Записей нет.</p>}
      </div>
    </div>
  );

  if (draft && canEdit) {
    const set = (patch: Partial<DefectEntry>) => setDraft({ ...draft, ...patch });
    return (
      <div className="bg-slate-800/80 border border-slate-600 rounded-lg p-4 space-y-3">
        <h3 className="text-white font-semibold">{defects.some((d) => d.id === draft.id) ? '✏️ Правка дефекта' : '➕ Новый дефект'}</h3>
        <div><label className={labelCls}>Название</label>
          <input className={inputCls} value={draft.title} onChange={(e) => set({ title: e.target.value })} /></div>
        <div><label className={labelCls}>Критичность</label>
          <select className={inputCls} value={draft.severity} onChange={(e) => set({ severity: e.target.value as DefectEntry['severity'] })}>
            <option value="critical">🔴 Критичный (отбраковка)</option>
            <option value="non-critical">🟡 Не критичный (допустим в пределах нормы)</option>
          </select></div>
        <div><label className={labelCls}>Как проявляется / откуда</label>
          <textarea className={inputCls} rows={2} value={draft.description ?? ''} onChange={(e) => set({ description: e.target.value })} /></div>
        <div><label className={labelCls}>Требуемое действие</label>
          <input className={inputCls} value={draft.action ?? ''} onChange={(e) => set({ action: e.target.value })} /></div>
        {error&&<p role="alert" className="text-sm text-red-200">{error}</p>}
        <div className="flex flex-wrap gap-2">
          <button className="min-h-11 px-3 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white disabled:opacity-40"
            disabled={busy||!draft.title.trim()} onClick={()=>void save()}>{busy?'Сохранение…':'💾 Сохранить локально'}</button>
          <button disabled={busy} className="min-h-11 px-3 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white" onClick={() => setDraft(null)}>Отмена</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {success&&<p role="status" className="text-sm text-emerald-200">{success}</p>}
      {canEdit && (
        <button className="min-h-11 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 rounded text-sm text-white"
          onClick={() => {setError('');setSuccess('');setDraft({
            id: uuidv4(), title: '', severity: 'non-critical',
            createdAt: Date.now(), updatedAt: Date.now(),
          });}}>
          ➕ Добавить дефект в реестр
        </button>
      )}
      <Group title="🔴 Критичные дефекты" items={critical} tone="text-rose-300" />
      <Group title="🟡 Не критичные дефекты" items={nonCritical} tone="text-amber-300" />
      {!canEdit && (
        <p className="text-xs text-slate-500">Реестр ведёт технолог (или master-устройство). Здесь — просмотр; обновления приходят пакетами «defect-entry».</p>
      )}
    </div>
  );
}

// ---------- 📒 Журнал сортировки ----------
function JournalTab({ runs, onSend }: {
  runs: SortRun[];
  onSend: (r: SortRun) => void;
}) {
  if (runs.length === 0) {
    return <p className="text-slate-500 text-sm">Журнал сортировки пуст. Записи появятся после завершения трёх станций или из сохранённых исторических результатов.</p>;
  }
  return (
    <div className="space-y-3">
      {runs.map((r) => (
        <div key={r.id} className="bg-slate-800/70 border border-slate-700 rounded-lg p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="text-white font-semibold">
                🔀 {r.batchName}
                <span className="ml-2 text-xs font-normal text-slate-400">{new Date(r.createdAt).toLocaleString('ru-RU')}</span>
              </div>
              <div className="mt-1 text-xs text-slate-300">
                {r.cutRunId&&<p className="break-all">Партия нарезки: {r.cutRunId} · Спецификация: {r.specId} (сохранённая версия)</p>}
                Пришло годных: <b>{r.goodCount}</b> · Разнесено: {r.buckets.reduce((s, b) => s + b.count, 0)} ·
                Отбраковано: <b className="text-rose-300">{r.rejected}</b>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {r.buckets.map((b, i) => (
                  <span key={i} className="text-xs px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-slate-200">
                    {b.categoryName}: <b className="text-white">{b.count}</b> шт
                    {b.avgThicknessUm != null ? ` · ⌀≈${b.avgThicknessUm} мкм` : ''}
                    {b.avgMassG != null ? ` · m≈${b.avgMassG} г` : ''}
                  </span>
                ))}
              </div>
              {r.sortingWorkflow ? <details className="mt-3 rounded-lg border border-slate-600 bg-slate-900/60 p-3">
                <summary className="text-sm text-blue-200 cursor-pointer">
                  Этапы контроля: визуальный → толщина → масса · {r.sortingWorkflow.mode==='grading'?'градация':'годен / брак'}
                </summary>
                <div className="mt-2 space-y-2">
                  {r.sortingWorkflow.stages.map((stage,i)=><div key={stage.station} className="border-b border-slate-700 pb-2 text-xs text-slate-300">
                    <p className="text-white font-medium">{['1. Визуальный контроль','2. Контроль толщины','3. Контроль массы'][i]}</p>
                    <p>На входе: {stage.inputCount} · годных: <b className="text-emerald-300">{stage.passedCount}</b> · брак: <b className="text-rose-300">{stage.rejectedCount}</b></p>
                    {stage.grades?.map(g=><p key={g.categoryName}>{g.categoryName}: {g.count} шт</p>)}
                    {stage.rejectionReasons?.map(reason=><p key={reason.reason}>Причина брака: {reason.reason} · {reason.count} шт</p>)}
                    <p className="text-slate-400">Оператор: {stage.workerId} · {new Date(stage.recordedAt).toLocaleString('ru-RU')}</p>
                    {stage.notes&&<p className="text-slate-400">Примечание: {stage.notes}</p>}
                  </div>)}
                </div>
              </details> :
                <p className="mt-2 text-xs text-slate-400">Историческая запись: сведения по отдельным станциям не сохранились.</p>}
              {r.defects && <div className="mt-1 text-xs text-amber-300">⚠ Дефекты: {r.defects}</div>}
              {r.notes && <div className="mt-1 text-xs text-slate-400">📝 {r.notes}</div>}
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white"
                onClick={() => onSend(r)}>
                📤 Передать сохранённый результат
              </button>

            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
