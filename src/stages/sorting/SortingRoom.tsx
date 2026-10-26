// Комната «Сортировка электродов». Полностью офлайн.
// Вкладки: 📥 Партии с нарезки · 📐 Спецификации технолога (КД) · 🔀 Сортировка ·
//          🗂️ Реестр дефектов · 📒 Журнал · 💬 Комментарии
// Цепочка данных: нарезка → (cut-run: название партии + годные) сюда;
// технолог задаёт параметры сортировки → (sort-spec); оператор разносит электроды
// по категориям (толщина/масса из КД, допустимые дефекты из реестра) →
// результат (sort-run) передаётся мастеру/технологу (master) и дальше на сборку.

import React, { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import {
  CutRun, DefectEntry, ElectrodeShape, SortBucket, SortCategory, SortRun,
  SortSpec, StageId, SyncPacket, UserRole,
} from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { PacketOutModal } from '../_ui/PacketOutModal';

type Tab = 'batches' | 'specs' | 'sort' | 'defects' | 'journal' | 'comments';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
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

  const defects = useLiveQuery(async () => {
    const all = await db.defectRegistry.toArray();
    return all.sort((a, b) => (a.severity === b.severity ? a.title.localeCompare(b.title, 'ru') : a.severity === 'critical' ? -1 : 1));
  }, []);

  const tasks = useLiveQuery(async () => {
    const all = await db.tasks.toArray();
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
          onSort={(id) => { setSelectedBatchId(id); setTab('sort'); }}
        />
      )}

      {tab === 'specs' && (
        <SpecsTab
          specs={specs ?? []}
          batches={batches ?? []}
          defects={defects ?? []}
          canEdit={isTechManager}
          userId={currentUser?.id ?? ''}
          onSave={(spec, forced) => {
            const fresh = { ...spec, updatedAt: Date.now() };
            db.sortSpecs.put(fresh);
            setOutPacket({
              v: 1, type: forced ? 'forced-push' : 'sort-spec', stage: StageId.SORTING,
              payload: fresh, from: currentUser!.id, ts: Date.now(), forced: forced || undefined,
            });
          }}
        />
      )}

      {tab === 'sort' && (
        <SortTab
          batches={batches ?? []}
          specs={specs ?? []}
          defects={defects ?? []}
          selectedBatchId={selectedBatchId}
          onSelectBatch={setSelectedBatchId}
          hasUser={!!currentUser}
          onSave={(run) => {
            const fresh = { ...run, workerId: currentUser!.id, updatedAt: Date.now() };
            db.sortRuns.put(fresh);
            setOutPacket({
              v: 1, type: 'sort-run', stage: StageId.SORTING,
              payload: fresh, from: currentUser!.id, ts: Date.now(),
            });
          }}
        />
      )}

      {tab === 'defects' && (
        <DefectsTab
          defects={defects ?? []}
          canEdit={isTechManager}
          onSave={(d) => {
            const fresh = { ...d, updatedAt: Date.now() };
            db.defectRegistry.put(fresh);
            setOutPacket({
              v: 1, type: 'defect-entry', stage: StageId.SORTING,
              payload: fresh, from: currentUser!.id, ts: Date.now(),
            });
          }}
        />
      )}

      {tab === 'journal' && (
        <JournalTab
          runs={runs ?? []}
          canForce={isTechManager}
          onSend={(r, forced) => {
            const fresh = { ...r, updatedAt: Date.now() };
            db.sortRuns.put(fresh);
            setOutPacket({
              v: 1, type: forced ? 'forced-push' : 'sort-run', stage: StageId.SORTING,
              payload: fresh, from: currentUser!.id, ts: Date.now(), forced: forced || undefined,
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
function BatchesTab({ items, specs, onSort }: {
  items: CutRun[]; specs: SortSpec[]; onSort: (id: string) => void;
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
        const spec = specs.find((s) => s.cutRunId === cr.id || s.batchName === cr.incomingId);
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
                    : <span className="text-slate-500">Спецификация технолога (КД) ещё не получена — дождитесь пакет «sort-spec»</span>}
                </div>
              </div>
              <button
                onClick={() => onSort(cr.id)}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white shrink-0"
              >
                🔀 Сортировать
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
  onSave: (spec: SortSpec, forced: boolean) => void;
}) {
  const [editing, setEditing] = useState<SortSpec | null>(null);
  const [isNew, setIsNew] = useState(false);

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
        onCancel={() => setEditing(null)}
        onSave={(forced) => { onSave(editing, forced); setEditing(null); }}
        onChange={setEditing}
      />
    );
  }

  return (
    <div className="space-y-3">
      {canEdit && (
        <button
          onClick={() => { setIsNew(true); setEditing(blank()); }}
          className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm text-white"
        >
          ➕ Новая спецификация (КД)
        </button>
      )}
      {specs.length === 0 && (
        <p className="text-slate-500 text-sm">Спецификаций пока нет. Технолог создаёт их здесь или присылает пакетом «sort-spec».</p>
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
                onClick={() => { setIsNew(false); setEditing({ ...s, categories: s.categories.map((c) => ({ ...c })) }); }}
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

function SpecEditor({ spec, isNew, batches, defects, canEdit, onCancel, onSave, onChange }: {
  spec: SortSpec; isNew: boolean; batches: CutRun[]; defects: DefectEntry[];
  canEdit: boolean; onCancel: () => void; onSave: (forced: boolean) => void;
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
            <option value="plate">▭ Призматические</option>
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

      <div className="flex flex-wrap gap-2">
        <button className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white disabled:opacity-40"
          disabled={!canEdit || !spec.batchName.trim()}
          onClick={() => onSave(false)}>
          💾 Сохранить и отправить (QR/BLE/текст)
        </button>
        {canEdit && (
          <button className="px-3 py-1.5 bg-purple-700 hover:bg-purple-600 rounded text-sm text-white"
            disabled={!spec.batchName.trim()}
            onClick={() => onSave(true)}>
          👑 Принудительно (master → slave)
          </button>
        )}
        <button className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </div>
  );
}

// ---------- 🔀 Сортировка: разнос по категориям ----------
function SortTab({ batches, specs, defects, selectedBatchId, onSelectBatch, hasUser, onSave }: {
  batches: CutRun[]; specs: SortSpec[]; defects: DefectEntry[];
  selectedBatchId: string | null; onSelectBatch: (id: string) => void;
  hasUser: boolean;
  onSave: (run: SortRun) => void;
}) {
  const [batchId, setBatchId] = useState<string | null>(selectedBatchId);
  const batch = batches.find((b) => b.id === batchId) ?? null;
  const spec = useMemo(() => {
    if (!batch) return null;
    return specs.find((s) => s.cutRunId === batch.id)
      ?? specs.find((s) => s.batchName === batch.incomingId) ?? null;
  }, [batch, specs]);

  const [counts, setCounts] = useState<Record<number, string>>({});
  const [avgUm, setAvgUm] = useState<Record<number, string>>({});
  const [avgMass, setAvgMass] = useState<Record<number, string>>({});
  const [rejected, setRejected] = useState('');
  const [defectIds, setDefectIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');

  const pickBatch = (id: string) => { setBatchId(id); onSelectBatch(id); setCounts({}); setAvgUm({}); setAvgMass({}); setRejected(''); setDefectIds([]); setNotes(''); };

  if (batches.length === 0) {
    return <p className="text-slate-500 text-sm">Нет партий для сортировки — дождитесь данных с нарезки (вкладка «📥 Партии с нарезки»).</p>;
  }

  const totalSorted = Object.values(counts).reduce((s, v) => s + (Number(v) || 0), 0);
  const goodIn = batch?.goodCount ?? 0;
  const accounted = totalSorted + (Number(rejected) || 0);
  const diff = goodIn - accounted;
  const balanceOk = batch != null && diff === 0 && totalSorted > 0;

  const save = () => {
    if (!batch || !spec || !balanceOk) return;
    const buckets: SortBucket[] = spec.categories
      .map((c, i): SortBucket => ({
        categoryName: c.name, count: Number(counts[i]) || 0,
        avgThicknessUm: avgUm[i] ? Number(avgUm[i]) : undefined,
        avgMassG: avgMass[i] ? Number(avgMass[i]) : undefined,
      }))
      .filter((b) => b.count > 0);
    const defectTitles = defectIds.map((id) => defects.find((d) => d.id === id)?.title ?? id).join(', ');
    onSave({
      id: uuidv4(), specId: spec.id, batchName: batch.incomingId,
      goodCount: batch.goodCount, buckets, rejected: Number(rejected) || 0,
      defects: defectTitles || undefined, notes: notes.trim() || undefined,
      workerId: '', createdAt: Date.now(), updatedAt: Date.now(),
    });
    setBatchId(null); setCounts({}); setAvgUm({}); setAvgMass({}); setRejected(''); setDefectIds([]); setNotes('');
  };

  return (
    <div className="space-y-3">
      <div>
        <label className={labelCls}>Партия с нарезки</label>
        <select className={inputCls} value={batchId ?? ''} onChange={(e) => pickBatch(e.target.value)}>
          <option value="">— выберите партию —</option>
          {batches.map((b) => (
            <option key={b.id} value={b.id}>{b.incomingId} · годных {b.goodCount} шт</option>
          ))}
        </select>
      </div>

      {!batch && <p className="text-slate-500 text-sm">Выберите партию, чтобы начать разнос по категориям.</p>}

      {batch && !spec && (
        <div className="bg-amber-900/30 border border-amber-700 rounded-lg p-3 text-sm text-amber-200">
          ⚠ Для партии «{batch.incomingId}» нет спецификации технолога (КД). Дождитесь пакет «sort-spec»
          или попросите технолога создать спецификацию во вкладке «📐 Спецификации КД».
        </div>
      )}

      {batch && spec && (
        <div className="bg-slate-800/80 border border-slate-600 rounded-lg p-4 space-y-3">
          <div className="text-white font-semibold">🔀 Разнос партии «{batch.incomingId}» · {spec.parameterName} ({spec.unit})</div>
          <div className="text-xs text-slate-400">Пришло годных с нарезки: <b className="text-emerald-300">{batch.goodCount}</b> шт</div>

          <div className="space-y-2">
            {spec.categories.map((c, i) => (
              <div key={i} className="bg-slate-900/70 border border-slate-700 rounded p-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-300">
                  <b className="text-white text-sm">{c.name}</b>
                  {c.minUm != null || c.maxUm != null ? <span>⌀ {c.minUm ?? '—'}–{c.maxUm ?? '—'} мкм</span> : null}
                  {c.minMass != null || c.maxMass != null ? <span>масса {c.minMass ?? '—'}–{c.maxMass ?? '—'} г</span> : null}
                  {c.allowedDefects && c.allowedDefects.length > 0 && (
                    <span className="text-amber-300">доп.: {c.allowedDefects.map((id) => defects.find((d) => d.id === id)?.title ?? id).join(', ')}</span>
                  )}
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2">
                  <div>
                    <label className={labelCls}>Кол-во, шт</label>
                    <input className={inputCls} type="number" min="0" value={counts[i] ?? ''}
                      onChange={(e) => setCounts({ ...counts, [i]: e.target.value })} placeholder="0" />
                  </div>
                  <div>
                    <label className={labelCls}>Ср. толщина, мкм</label>
                    <input className={inputCls} type="number" step="any" value={avgUm[i] ?? ''}
                      onChange={(e) => setAvgUm({ ...avgUm, [i]: e.target.value })} placeholder="—" />
                  </div>
                  <div>
                    <label className={labelCls}>Ср. масса, г</label>
                    <input className={inputCls} type="number" step="any" value={avgMass[i] ?? ''}
                      onChange={(e) => setAvgMass({ ...avgMass, [i]: e.target.value })} placeholder="—" />
                  </div>
                </div>
                {(c.minUm != null || c.maxUm != null) && avgUm[i] && (
                  <ControlHint num={Number(avgUm[i])} min={c.minUm} max={c.maxUm} what="толщина" />
                )}
                {(c.minMass != null || c.maxMass != null) && avgMass[i] && (
                  <ControlHint num={Number(avgMass[i])} min={c.minMass} max={c.maxMass} what="масса" />
                )}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Отбраковано (не подошли ни к одному сорту), шт</label>
              <input className={inputCls} type="number" min="0" value={rejected}
                onChange={(e) => setRejected(e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className={labelCls}>Замеченные дефекты (из реестра)</label>
              <div className="flex flex-wrap gap-1">
                {defects.map((d) => {
                  const on = defectIds.includes(d.id);
                  return (
                    <button key={d.id}
                      onClick={() => setDefectIds(on ? defectIds.filter((x) => x !== d.id) : [...defectIds, d.id])}
                      className={`text-[10px] px-1.5 py-0.5 rounded border ${on
                        ? d.severity === 'critical'
                          ? 'bg-rose-900/70 border-rose-600 text-rose-200'
                          : 'bg-amber-900/60 border-amber-600 text-amber-200'
                        : 'bg-slate-800 border-slate-700 text-slate-400'}`}
                    >
                      {d.severity === 'critical' ? '🔴' : '🟡'} {d.title}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div>
            <label className={labelCls}>Примечания оператора</label>
            <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {/* Баланс партии */}
          <div className={`rounded-lg p-3 text-sm border ${balanceOk
            ? 'bg-emerald-900/30 border-emerald-700 text-emerald-200'
            : 'bg-slate-900/70 border-slate-700 text-slate-300'}`}>
            Разнесено: <b>{totalSorted}</b> + отбраковано <b>{Number(rejected) || 0}</b> = <b>{accounted}</b> из <b>{goodIn}</b> годных.
            {diff > 0 && <span className="text-amber-300"> · не учтено {diff} шт</span>}
            {diff < 0 && <span className="text-rose-300"> · перебор на {-diff} шт</span>}
            {balanceOk ? ' ✅ баланс сходится' : ''}
          </div>

          <button
            onClick={save}
            disabled={!hasUser || !balanceOk}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 rounded text-sm text-white"
          >
            💾 Записать в журнал и отправить (sort-run → master)
          </button>
        </div>
      )}
    </div>
  );
}

function ControlHint({ num, min, max, what }: { num: number; min?: number; max?: number; what: string }) {
  if (!Number.isFinite(num)) return null;
  const below = min != null && num < min;
  const above = max != null && num > max;
  if (!below && !above) return <div className="mt-1 text-[11px] text-emerald-300">✓ {what} в допуске</div>;
  return <div className="mt-1 text-[11px] text-rose-300">⚠ {what} вне допуска КД ({below ? 'ниже минимума' : 'выше максимума'}) — проверьте отнесение к сорту</div>;
}

// ---------- 🗂️ Реестр дефектов ----------
function DefectsTab({ defects, canEdit, onSave }: {
  defects: DefectEntry[]; canEdit: boolean;
  onSave: (d: DefectEntry) => void;
}) {
  const [draft, setDraft] = useState<DefectEntry | null>(null);

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
                  onClick={() => setDraft({ ...d })}>✏️</button>
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
        <div className="flex gap-2">
          <button className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white disabled:opacity-40"
            disabled={!draft.title.trim()}
            onClick={() => { onSave(draft); setDraft(null); }}>💾 Сохранить и отправить</button>
          <button className="px-3 py-1.5 bg-slate-700 hover:bg-slate-600 rounded text-sm text-white" onClick={() => setDraft(null)}>Отмена</button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {canEdit && (
        <button className="px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 rounded text-sm text-white"
          onClick={() => setDraft({
            id: uuidv4(), title: '', severity: 'non-critical',
            createdAt: Date.now(), updatedAt: Date.now(),
          })}>
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
function JournalTab({ runs, canForce, onSend }: {
  runs: SortRun[]; canForce: boolean;
  onSend: (r: SortRun, forced: boolean) => void;
}) {
  if (runs.length === 0) {
    return <p className="text-slate-500 text-sm">Журнал сортировки пуст. Записи появятся после разноса партий.</p>;
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
              {r.defects && <div className="mt-1 text-xs text-amber-300">⚠ Дефекты: {r.defects}</div>}
              {r.notes && <div className="mt-1 text-xs text-slate-400">📝 {r.notes}</div>}
            </div>
            <div className="flex flex-col gap-1 shrink-0">
              <button className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-sm text-white"
                onClick={() => onSend(r, false)}>
                📤 Отправить партию дальше
              </button>
              {canForce && (
                <button className="px-3 py-1 bg-purple-700 hover:bg-purple-600 rounded text-xs text-white"
                  onClick={() => onSend(r, true)}>
                  👑 Принудительно всем (master)
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
