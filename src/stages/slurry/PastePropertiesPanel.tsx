// Панель расчётных свойств пасты замеса: содержание твёрдых веществ (СВ),
// плотности, объём и вязкость по реологическим моделям (Айзенштейн, Марон–Пирсон,
// Муни, Кросс). Полностью офлайн — считает по базе компонентов и текущим граммовкам.

import React from 'react';
import { PasteProperties, VISCOSITY_MODELS, ViscosityModelId } from './mixMath';

interface Props {
  paste: PasteProperties | null;
  phiMax: number;                 // φm — максимальная упаковка (редактируется пользователем)
  shearRate: number;              // γ̇ для модели Кросса
  onPhiMaxChange: (v: number) => void;
  onShearRateChange: (v: number) => void;
}

const num = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—');

export function PastePropertiesPanel({ paste, phiMax, shearRate, onPhiMaxChange, onShearRateChange }: Props) {
  if (!paste) return null;

  const nearLimit = paste.packingFraction > phiMax * 0.92;
  const overLimit = paste.packingFraction >= phiMax;

  return (
    <div className="space-y-3 bg-slate-900/60 border border-slate-700 rounded-lg p-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <p className="text-sm font-semibold text-slate-200">🧫 Расчётные свойства пасты</p>
        <span className="text-[10px] text-slate-500">офлайн-модели реологии суспензий</span>
      </div>

      {/* Твёрдые вещества */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Stat label="СВ, масс." value={`${num(paste.solidsPctMass)} %`} accent={nearLimit} />
        <Stat label="СВ, объём (φ)" value={`${num(paste.solidsPctVol)} %`} accent={nearLimit} />
        <Stat label="Макс. СВ при φm" value={`${num(paste.maxSolidsPctMass)} %`} />
        <Stat label="Пористость упаковки" value={`${num(paste.porosityAtPacking)} %`} />
      </div>

      {/* Плотности и объём */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <Stat label="ρ истинная СВ" value={`${num(paste.trueDensitySolid, 2)} г/см³`} />
        <Stat label="ρ утряски СВ" value={Number.isFinite(paste.bulkDensitySolid) ? `${num(paste.bulkDensitySolid, 2)} г/см³` : 'нет данных'} />
        <Stat label="ρ пасты расч." value={`${num(paste.pasteDensity, 2)} г/см³`} />
        <Stat label="Объём замеса" value={`${num(paste.pasteVolumeCm3 / 1000, 1)} л`} />
      </div>

      {overLimit && (
        <p className="text-xs text-red-400 bg-red-950/40 border border-red-800 rounded px-2 py-1">
          ⚠️ φ ≥ φm: паста выше предела упаковки — по физике она не течёт (пересыщенный замес).
          Увеличьте долю растворителя или уменьшите φm, если частицы крупные/полидисперсные.
        </p>
      )}

      {/* Настройки моделей */}
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs text-slate-400 space-y-1">
          <span>φm — макс. степень упаковки (0.55–0.70 типично)</span>
          <input type="number" step="0.01" min={0.1} max={0.9}
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white"
            value={phiMax} onChange={(e) => onPhiMaxChange(Number(e.target.value) || 0.62)} />
        </label>
        <label className="text-xs text-slate-400 space-y-1">
          <span>γ̇ — скорость сдвига для модели Кросса, 1/с</span>
          <input type="number" step="1" min={0.1}
            className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white"
            value={shearRate} onChange={(e) => onShearRateChange(Number(e.target.value) || 50)} />
        </label>
      </div>

      {/* Вязкости по моделям */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-700">
              <th className="py-1 pr-2">Модель</th>
              <th className="py-1 pr-2">Формула</th>
              <th className="py-1 pr-2">η/η₀</th>
              <th className="py-1 pr-2">η, мПа·с (сП)</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(VISCOSITY_MODELS) as ViscosityModelId[]).map((id) => (
              <tr key={id} className={`border-b border-slate-800 ${id === 'maronpearson' ? 'text-emerald-300' : 'text-slate-200'}`}>
                <td className="py-1 pr-2 whitespace-nowrap">
                  {VISCOSITY_MODELS[id].name}
                  {id === 'maronpearson' && <span className="ml-1 text-[9px] bg-emerald-900/60 text-emerald-300 px-1 rounded">рекоменд.</span>}
                </td>
                <td className="py-1 pr-2 font-mono text-slate-400">{VISCOSITY_MODELS[id].formula}</td>
                <td className="py-1 pr-2 font-mono">{num(paste.etaRel[id], 2)}</td>
                <td className="py-1 pr-2 font-mono">
                  {paste.etaAbs[id] > 1_000_000 ? '> 1 000 000' : Math.round(paste.etaAbs[id]).toLocaleString('ru-RU')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="text-[11px] text-slate-400">
        <summary className="cursor-pointer select-none">Как читать эти цифры</summary>
        <ul className="list-disc pl-5 mt-1 space-y-1">
          <li><b>η₀</b> — вязкость чистой жидкой фазы (растворители из базы компонентов): {num(paste.baseViscosityPas * 1000, 3)} мПа·с.</li>
          <li><b>φ</b> — какой объём занимает твёрдая фаза в пасте. При φ → φm вязкость уходит в бесконечность (паста перестаёт течь).</li>
          <li><b>Марон–Пирсон</b> — основная оценка «сверху» для рабочих замесов; <b>Айзенштейн</b> — нижняя граница (разбавленная суспензия).</li>
          <li><b>Кросс</b> показывает вязкость при конкретной скорости сдвига γ̇: чем быстрее мешалка/вискозиметр, тем ниже кажущаяся вязкость (сдвиговое разжижение).</li>
          <li>Точность зависит от заполненности базы компонентов (истинная плотность, вязкость растворителя). Пустые поля дооцениваются типовыми значениями.</li>
        </ul>
      </details>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded px-2 py-1.5 border ${accent ? 'bg-amber-950/40 border-amber-800' : 'bg-slate-800/60 border-slate-700'}`}>
      <div className="text-[10px] text-slate-400">{label}</div>
      <div className={`font-mono text-sm ${accent ? 'text-amber-300' : 'text-white'}`}>{value}</div>
    </div>
  );
}
