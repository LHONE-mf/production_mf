// Шлам-калькулятор: расчёт массы компонентов шлама по процентам на заданную массу замеса.

import React, { useMemo, useState } from 'react';

interface Component { name: string; pct: number }

const DEFAULT_RECIPE: Component[] = [
  { name: 'Активный материал (LFP)', pct: 94 },
  { name: 'PVDF (связующее)', pct: 3 },
  { name: 'Добавка проводящая (CB)', pct: 2 },
  { name: 'Растворитель (NMP/вода)', pct: 50 }, // сверх 100% — доля от массы сухих веществ
];

export function SlurryCalculator() {
  const [batchKg, setBatchKg] = useState(240);
  const [components, setComponents] = useState(DEFAULT_RECIPE);

  const drySum = components.slice(0, 3).reduce((s, c) => s + c.pct, 0);
  const results = useMemo(() => {
    const dryTotal = (batchKg * drySum) / 100 / (1 + (components[3]?.pct ?? 0) / 100);
    return components.map((c, i) => ({
      ...c,
      kg: i < 3 ? (dryTotal * c.pct) / 100 : dryTotal * (c.pct / 100),
    }));
  }, [batchKg, components, drySum]);

  const setPct = (i: number, v: number) =>
    setComponents((cs) => cs.map((c, j) => (j === i ? { ...c, pct: v } : c)));

  return (
    <div className="bg-slate-800 border border-slate-700 rounded-lg p-4 space-y-4">
      <h3 className="text-white font-semibold">🧪 Шлам-калькулятор</h3>
      <label className="flex items-center gap-3 text-sm text-slate-300">
        Масса замеса, кг
        <input
          type="number" min={1} value={batchKg}
          onChange={(e) => setBatchKg(Number(e.target.value))}
          className="w-32 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white"
        />
      </label>
      <div className="space-y-2">
        {components.map((c, i) => (
          <div key={c.name} className="flex items-center gap-3 text-sm">
            <span className="flex-1 text-slate-200">{c.name}</span>
            <input
              type="number" min={0} step={0.5} value={c.pct}
              onChange={(e) => setPct(i, Number(e.target.value))}
              className="w-20 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white"
            />
            <span className="text-slate-400 w-8">%</span>
            <span className="text-blue-300 w-20 text-right font-mono">{results[i].kg.toFixed(2)} кг</span>
          </div>
        ))}
      </div>
      <div className="border-t border-slate-700 pt-2 text-sm text-slate-300 flex justify-between">
        <span>Суммарно (сухие {drySum}%):</span>
        <span className="font-mono text-white">{results.reduce((s, r) => s + r.kg, 0).toFixed(2)} кг</span>
      </div>
      <p className="text-xs text-slate-500">
        Пропорции задаёт технолог. Растворитель указан как % от массы сухих веществ.
      </p>
    </div>
  );
}
