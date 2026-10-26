// KPI-дашборд производства.
// Источник данных — ТОЛЬКО локальная база Dexie (журналы комнат). Полный офлайн.
// Показывает: движение партии по цепочке, выпуск ячеек, годность, КУЭ и ёмкость 5-го цикла.
// Таблицы и поля соответствуют реальной схеме src/core/db/index.ts.

import React, { useEffect, useMemo, useState } from 'react';
import { db } from '../core/db';
import { useAuthStore } from '../core/store/authStore';
import { TaskStatus } from '../core/types';
import type {
  MixBatch, CoatRun, CalenderRun, CutRun, SortRun, AssemblyRun,
  FillRun, WalzRun, FormationRun, Task,
} from '../core/types';

// ─── Утилиты ──────────────────────────────────────────────────────────────

/** createdAt в этих таблицах бывает number (мс) или string (ISO) — приводим к мс */
const toMs = (v: unknown): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const p = Date.parse(v); return Number.isNaN(p) ? 0 : p; }
  if (v instanceof Date) return v.getTime();
  return 0;
};

const pct = (part: number, total: number): string =>
  total > 0 ? ((part / total) * 100).toFixed(1) + '%' : '—';

const avg = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

const fmtDate = (ms: number): string =>
  ms ? new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '—';

// ─── Карточки метрик ──────────────────────────────────────────────────────

interface CardProps { label: string; value: string; sub?: string; tone?: 'good' | 'bad' | 'warn' | 'info' }

const KpiCard: React.FC<CardProps> = ({ label, value, sub, tone = 'info' }) => {
  const tones: Record<string, string> = {
    good: 'border-emerald-700 bg-emerald-900/30',
    bad: 'border-rose-700 bg-rose-900/30',
    warn: 'border-amber-700 bg-amber-900/30',
    info: 'border-slate-700 bg-slate-800/60',
  };
  return (
    <div className={`rounded-xl border p-4 ${tones[tone]}`}>
      <p className="text-xs uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-white">{value}</p>
      {sub && <p className="mt-1 text-xs text-slate-400">{sub}</p>}
    </div>
  );
};

// ─── Основной компонент ───────────────────────────────────────────────────

export const KpiDashboard: React.FC = () => {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [days, setDays] = useState<number>(7); // окно: 7 / 30 / всё
  const [loading, setLoading] = useState(true);

  const [mixes, setMixes] = useState<MixBatch[]>([]);
  const [coats, setCoats] = useState<CoatRun[]>([]);
  const [calenders, setCalenders] = useState<CalenderRun[]>([]);
  const [cuts, setCuts] = useState<CutRun[]>([]);
  const [sorts, setSorts] = useState<SortRun[]>([]);
  const [assemblies, setAssemblies] = useState<AssemblyRun[]>([]);
  const [fills, setFills] = useState<FillRun[]>([]);
  const [walz, setWalz] = useState<WalzRun[]>([]);
  const [formations, setFormations] = useState<FormationRun[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [usersMap, setUsersMap] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, c, cal, cu, so, asm, fi, wa, fo, tk, us] = await Promise.all([
          db.mixBatches.toArray(),
          db.coatRuns.toArray(),
          db.calenderRuns.toArray(),
          db.cuttingRuns.toArray(),
          db.sortRuns.toArray(),
          db.assemblyRuns.toArray(),
          db.fillRuns.toArray(),
          db.walzRuns.toArray(),
          db.formationRuns.toArray(),
          db.tasks.toArray(),
          db.users.toArray(),
        ]);
        if (cancelled) return;
        setMixes(m); setCoats(c); setCalenders(cal); setCuts(cu); setSorts(so);
        setAssemblies(asm); setFills(fi); setWalz(wa); setFormations(fo); setTasks(tk);
        const map: Record<string, string> = {};
        us.forEach((u) => { map[u.id] = u.fullName || u.login; });
        setUsersMap(map);
      } catch (e) {
        console.error('KPI: ошибка чтения базы', e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const sinceMs = useMemo(
    () => (days > 0 ? Date.now() - days * 24 * 3600 * 1000 : 0),
    [days],
  );
  const inWindow = <T extends object>(arr: T[], pick: (x: T) => unknown) =>
    arr.filter((x) => toMs(pick(x)) >= sinceMs);

  // ── Расчётные KPI ──
  const kpi = useMemo(() => {
    const wMix = inWindow(mixes, (x) => x.createdAt);
    const wCoat = inWindow(coats, (x) => x.createdAt);
    const wCal = inWindow(calenders, (x) => x.createdAt);
    const wCut = inWindow(cuts, (x) => x.createdAt);
    const wSort = inWindow(sorts, (x) => x.createdAt);
    const wAsm = inWindow(assemblies, (x) => x.createdAt);
    const wFill = inWindow(fills, (x) => x.createdAt);
    const wWalz = inWindow(walz, (x) => x.createdAt);
    const wForm = inWindow(formations, (x) => x.createdAt);

    const sum = <T,>(arr: T[], f: (x: T) => number | undefined) =>
      arr.reduce((a, x) => a + (f(x) ?? 0), 0);

    const coatMeters = sum(wCoat, (x) => x.sideALengthM) + sum(wCoat, (x) => x.sideBLengthM);
    const cutGood = sum(wCut, (x) => x.goodCount);
    const cutDefect = sum(wCut, (x) => x.defectCount);
    const sortGood = sum(wSort, (x) => x.goodCount);
    const sortRejected = sum(wSort, (x) => x.rejected);
    const asmOut = sum(wAsm, (x) => x.cellsOut);
    const asmScrap = sum(wAsm, (x) => x.cellsScrap);
    const fillOut = sum(wFill, (x) => x.cellsFilled);
    const fillScrap = sum(wFill, (x) => x.cellsScrap);
    const walzOut = sum(wWalz, (x) => x.cellsOut);
    const walzScrap = sum(wWalz, (x) => x.cellsScrap);
    const formOut = sum(wForm, (x) => x.cellsOut);
    const formScrap = sum(wForm, (x) => x.cellsScrap);

    const coulombVals = wForm.map((x) => x.coulombEfficiencyPct).filter((v): v is number => typeof v === 'number');
    const cap5Vals = wForm.map((x) => x.capacityCycle5Ah).filter((v): v is number => typeof v === 'number');

    // Открытые задания (не завершены и не отклонены)
    const closedStatuses: TaskStatus[] = [TaskStatus.COMPLETED, TaskStatus.REJECTED];
    const openTasks = tasks.filter((t) => !closedStatuses.includes(t.status));
    const overdueTasks = openTasks.filter(
      (t) => t.dueDate != null && toMs(t.dueDate) < Date.now(),
    );

    // Конвейер: сколько записей на каждой станции за период
    const pipeline = [
      { stage: '🧪 Замесы', count: wMix.length },
      { stage: '🖌️ Намазка', count: wCoat.length },
      { stage: '🔄 Каландр', count: wCal.length },
      { stage: '✂️ Нарезка', count: wCut.length },
      { stage: '🗂️ Сортировка', count: wSort.length },
      { stage: '🔋 Сборка', count: wAsm.length },
      { stage: '💧 Заливка', count: wFill.length },
      { stage: '🎡 Вальцовка', count: wWalz.length },
      { stage: '⚡ Формировка', count: wForm.length },
    ];
    const maxPipeline = Math.max(1, ...pipeline.map((p) => p.count));

    // Работники: электроды (нарезка), ячейки (сборка), замесы
    const byWorker: Record<string, { electrodes: number; cells: number; batches: number }> = {};
    const ensure = (id: string) => {
      if (!byWorker[id]) byWorker[id] = { electrodes: 0, cells: 0, batches: 0 };
      return byWorker[id];
    };
    wCut.forEach((x) => { ensure(x.workerId).electrodes += x.goodCount; });
    wAsm.forEach((x) => { ensure(x.workerId).cells += x.cellsOut; });
    wMix.forEach((x) => { ensure(x.workerId).batches += 1; });
    const workerRows = Object.entries(byWorker)
      .map(([id, v]) => ({ id, name: usersMap[id] ?? id.slice(0, 8), ...v }))
      .sort((a, b) => (b.electrodes + b.cells * 50) - (a.electrodes + a.cells * 50))
      .slice(0, 8);

    return {
      wMix, wForm,
      mixKg: sum(wMix, (x) => x.batchKg),
      coatMeters,
      cutGood, cutDefect,
      sortGood, sortRejected,
      asmOut, asmScrap, fillOut, fillScrap,
      walzOut, walzScrap, formOut, formScrap,
      avgCoulomb: avg(coulombVals),
      avgCap5: avg(cap5Vals),
      openTasks: openTasks.length,
      overdueTasks: overdueTasks.length,
      pipeline, maxPipeline, workerRows,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, mixes, coats, calenders, cuts, sorts, assemblies, fills, walz, formations, tasks, usersMap]);

  // Годность сквозная: ячейки после формировки к собранным
  const yieldChain = kpi.asmOut > 0 ? pct(kpi.formOut, kpi.asmOut) : '—';

  if (loading) {
    return <div className="p-6 text-slate-300">Загрузка KPI из локальной базы…</div>;
  }

  const roleTitle: Record<string, string> = {
    worker: 'Работник', foreman: 'Мастер цеха', technologist: 'Технолог', chief: 'Начальник производства',
  };

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Шапка дашборда */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white">📊 KPI производства</h2>
          <p className="text-sm text-slate-400">
            Данные из журналов комнат · полностью офлайн · роль: {roleTitle[currentUser?.role ?? ''] ?? '—'}
          </p>
        </div>
        <div className="flex gap-2">
          {[
            { d: 7, l: '7 дней' },
            { d: 30, l: '30 дней' },
            { d: 0, l: 'Всё время' },
          ].map((o) => (
            <button
              key={o.d}
              onClick={() => setDays(o.d)}
              className={`rounded-lg px-3 py-1.5 text-sm border ${
                days === o.d
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {o.l}
            </button>
          ))}
        </div>
      </div>

      {/* Ключевые карточки */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard label="Собрано ячеек" value={String(kpi.asmOut)} sub={`брак: ${kpi.asmScrap}`} tone="info" />
        <KpiCard label="После формировки" value={String(kpi.formOut)} sub={`брак: ${kpi.formScrap}`} tone="info" />
        <KpiCard label="Годность цепочки" value={yieldChain} sub="формировка / сборка" tone={kpi.asmOut > 0 && kpi.formOut / kpi.asmOut >= 0.9 ? 'good' : 'warn'} />
        <KpiCard label="Средняя КУЭ" value={kpi.avgCoulomb != null ? kpi.avgCoulomb.toFixed(1) + '%' : '—'} sub={`${kpi.wForm.length} партий формировки`} tone="info" />
        <KpiCard label="Ёмкость 5-го цикла" value={kpi.avgCap5 != null ? kpi.avgCap5.toFixed(2) + ' А·ч' : '—'} sub="среднее по партиям" tone="info" />
        <KpiCard label="Замешано пасты" value={kpi.mixKg.toFixed(1) + ' кг'} sub={`${kpi.wMix.length} замесов`} tone="info" />
        <KpiCard label="Намазано" value={kpi.coatMeters.toFixed(0) + ' м'} sub="стороны A+B" tone="info" />
        <KpiCard label="Открытые задания" value={String(kpi.openTasks)} sub={kpi.overdueTasks > 0 ? `просрочено: ${kpi.overdueTasks}` : 'без просрочек'} tone={kpi.overdueTasks > 0 ? 'bad' : 'good'} />
      </div>

      {/* Конвейер движения партии */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-slate-300">
          Конвейер: записи на этапах за период
        </h3>
        <div className="space-y-2">
          {kpi.pipeline.map((p) => (
            <div key={p.stage} className="flex items-center gap-3">
              <span className="w-40 shrink-0 text-sm text-slate-300">{p.stage}</span>
              <div className="h-4 flex-1 rounded bg-slate-900 overflow-hidden">
                <div
                  className="h-full rounded bg-gradient-to-r from-blue-600 to-cyan-500"
                  style={{ width: `${Math.round((p.count / kpi.maxPipeline) * 100)}%` }}
                />
              </div>
              <span className="w-10 shrink-0 text-right text-sm font-mono text-white">{p.count}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Электроды: выход и дефекты */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Электродный участок</h3>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-700/60">
              <tr><td className="py-1.5 text-slate-400">Нарезано годных</td><td className="py-1.5 text-right font-mono text-white">{kpi.cutGood}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Дефект на нарезке</td><td className="py-1.5 text-right font-mono text-rose-400">{kpi.cutDefect}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Принято на сортировке</td><td className="py-1.5 text-right font-mono text-white">{kpi.sortGood}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Отбраковано при сортировке</td><td className="py-1.5 text-right font-mono text-rose-400">{kpi.sortRejected}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Годность нарезки</td><td className="py-1.5 text-right font-mono text-emerald-400">{pct(kpi.cutGood, kpi.cutGood + kpi.cutDefect)}</td></tr>
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
          <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">Ячейки: заливка → вальцовка → формировка</h3>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-slate-700/60">
              <tr><td className="py-1.5 text-slate-400">Залито ячеек</td><td className="py-1.5 text-right font-mono text-white">{kpi.fillOut}</td><td className="py-1.5 text-right text-xs text-rose-400">−{kpi.fillScrap}</td></tr>
              <tr><td className="py-1.5 text-slate-400">После вальцовки</td><td className="py-1.5 text-right font-mono text-white">{kpi.walzOut}</td><td className="py-1.5 text-right text-xs text-rose-400">−{kpi.walzScrap}</td></tr>
              <tr><td className="py-1.5 text-slate-400">После формировки</td><td className="py-1.5 text-right font-mono text-white">{kpi.formOut}</td><td className="py-1.5 text-right text-xs text-rose-400">−{kpi.formScrap}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Годность заливки</td><td className="py-1.5 text-right font-mono text-emerald-400">{pct(kpi.fillOut, kpi.fillOut + kpi.fillScrap)}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Годность вальцовки</td><td className="py-1.5 text-right font-mono text-emerald-400">{pct(kpi.walzOut, kpi.walzOut + kpi.walzScrap)}</td></tr>
              <tr><td className="py-1.5 text-slate-400">Годность формировки</td><td className="py-1.5 text-right font-mono text-emerald-400">{pct(kpi.formOut, kpi.formOut + kpi.formScrap)}</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Работники */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
          Работники за период (электроды / ячейки / замесы)
        </h3>
        {kpi.workerRows.length === 0 ? (
          <p className="text-sm text-slate-500">Нет записей в журналах за выбранный период.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500">
                  <th className="pr-4 pb-2">Работник</th>
                  <th className="pr-4 pb-2 text-right">Электроды</th>
                  <th className="pr-4 pb-2 text-right">Ячейки</th>
                  <th className="pb-2 text-right">Замесы</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {kpi.workerRows.map((w) => (
                  <tr key={w.id}>
                    <td className="py-1.5 pr-4 text-slate-200">{w.name}</td>
                    <td className="py-1.5 pr-4 text-right font-mono text-white">{w.electrodes}</td>
                    <td className="py-1.5 pr-4 text-right font-mono text-white">{w.cells}</td>
                    <td className="py-1.5 text-right font-mono text-white">{w.batches}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Последние партии формировки */}
      <div className="rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wider text-slate-300">
          Последние партии формировки (КУЭ / ёмкость 5-го цикла)
        </h3>
        {kpi.wForm.length === 0 ? (
          <p className="text-sm text-slate-500">Нет записей за выбранный период.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-slate-500">
                  <th className="pr-4 pb-2">Дата</th>
                  <th className="pr-4 pb-2">Партия</th>
                  <th className="pr-4 pb-2">Номера АК</th>
                  <th className="pr-4 pb-2 text-right">Годных</th>
                  <th className="pr-4 pb-2 text-right">КУЭ, %</th>
                  <th className="pb-2 text-right">C₅, А·ч</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-700/60">
                {[...kpi.wForm]
                  .sort((a, b) => toMs(b.startDate || b.createdAt) - toMs(a.startDate || a.createdAt))
                  .slice(0, 10)
                  .map((r) => (
                    <tr key={r.id}>
                      <td className="py-1.5 pr-4 text-slate-400">{fmtDate(toMs(r.startDate) || toMs(r.createdAt))}</td>
                      <td className="py-1.5 pr-4 text-slate-200">{r.batchName}</td>
                      <td className="py-1.5 pr-4 font-mono text-xs text-slate-400">
                        {r.serialRange ? `${r.serialRange.start}–${r.serialRange.end}` : '—'}
                      </td>
                      <td className="py-1.5 pr-4 text-right font-mono text-white">{r.cellsOut}</td>
                      <td className="py-1.5 pr-4 text-right font-mono text-emerald-400">
                        {r.coulombEfficiencyPct != null ? r.coulombEfficiencyPct.toFixed(1) : '—'}
                      </td>
                      <td className="py-1.5 text-right font-mono text-emerald-400">
                        {r.capacityCycle5Ah != null ? r.capacityCycle5Ah.toFixed(2) : '—'}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

export default KpiDashboard;
