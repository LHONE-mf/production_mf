// B-с6: Лазерная сварка призматических ячеек (герметизация крышки / шов корпуса).
// Отдельный файл — можно переписать целиком, не трогая остальные подсекции сборки.
// Оператор фиксирует: сколько ячеек подали, сколько годных получили, брак, параметры лазера
// (мощность, скорость, импульс, фокус, защита газом) и дефекты. Результат добавляется в AssemblyRun.ops.

import React, { useState } from 'react';
import { AssemblyOp, AssemblyRun } from '../../core/types';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

interface Props {
  run: AssemblyRun;
  workerId: string;
  onAddOp: (op: AssemblyOp) => void;
}

export function LaserPrismaticStation({ run, workerId, onAddOp }: Props) {
  const [qtyIn, setQtyIn] = useState('');
  const [qtyOut, setQtyOut] = useState('');
  const [qtyScrap, setQtyScrap] = useState('0');
  const [laserPower, setLaserPower] = useState('');   // мощность лазера, Вт
  const [speed, setSpeed] = useState('');             // скорость сварки, мм/с
  const [pulse, setPulse] = useState('');             // длительность импульса, мс
  const [focus, setFocus] = useState('');             // дефокусировка, мм
  const [gas, setGas] = useState('');                 // защитный газ и расход
  const [defects, setDefects] = useState('');
  const [note, setNote] = useState('');

  const ops = run.ops.filter((o) => o.substation === 'laser-prismatic');

  const save = () => {
    const inN = parseInt(qtyIn, 10), outN = parseInt(qtyOut, 10);
    if (!inN || isNaN(outN)) return;
    const params: Record<string, number | string> = {};
    if (laserPower) params['Мощность лазера, Вт'] = parseFloat(laserPower);
    if (speed) params['Скорость сварки, мм/с'] = parseFloat(speed);
    if (pulse) params['Импульс, мс'] = parseFloat(pulse);
    if (focus) params['Дефокус, мм'] = parseFloat(focus);
    if (gas) params['Защитный газ'] = gas;
    const op: AssemblyOp = {
      substation: 'laser-prismatic',
      workerId,
      finishedAt: new Date().toISOString(),
      qtyIn: inN,
      qtyOut: outN,
      qtyScrap: parseInt(qtyScrap, 10) || 0,
      params,
      defects: defects.split(',').map((s) => s.trim()).filter(Boolean),
      note: note.trim() || undefined,
    };
    onAddOp(op);
    setQtyIn(''); setQtyOut(''); setQtyScrap('0'); setLaserPower(''); setSpeed('');
    setPulse(''); setFocus(''); setGas(''); setDefects(''); setNote('');
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">
        🔦 Лазерная сварка призматических ячеек: герметизация крышки (шов по периметру) и приварка
        клемм лазерным лучом с газовой защитой. Финальная операция сборки призматических партий.
        Партия: <b className="text-white">{run.batchName}</b>
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        <div><label className={labelCls}>Подано ячеек, шт *</label>
          <input className={inputCls} type="number" value={qtyIn} onChange={(e) => setQtyIn(e.target.value)} placeholder="напр. 120" /></div>
        <div><label className={labelCls}>Годных ячеек, шт *</label>
          <input className={inputCls} type="number" value={qtyOut} onChange={(e) => setQtyOut(e.target.value)} placeholder="напр. 119" /></div>
        <div><label className={labelCls}>Брак, шт</label>
          <input className={inputCls} type="number" value={qtyScrap} onChange={(e) => setQtyScrap(e.target.value)} /></div>
        <div><label className={labelCls}>Мощность лазера, Вт</label>
          <input className={inputCls} type="number" value={laserPower} onChange={(e) => setLaserPower(e.target.value)} placeholder="напр. 2000" /></div>
        <div><label className={labelCls}>Скорость сварки, мм/с</label>
          <input className={inputCls} type="number" value={speed} onChange={(e) => setSpeed(e.target.value)} placeholder="напр. 50" /></div>
        <div><label className={labelCls}>Длительность импульса, мс</label>
          <input className={inputCls} type="number" value={pulse} onChange={(e) => setPulse(e.target.value)} placeholder="напр. 8" /></div>
        <div><label className={labelCls}>Дефокус, мм</label>
          <input className={inputCls} type="number" value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="напр. +2" /></div>
        <div><label className={labelCls}>Защитный газ (аргон, л/мин)</label>
          <input className={inputCls} value={gas} onChange={(e) => setGas(e.target.value)} placeholder="напр. Ar 15" /></div>
        <div><label className={labelCls}>Дефекты (через запятую)</label>
          <input className={inputCls} value={defects} onChange={(e) => setDefects(e.target.value)} placeholder="прожог, пора шва, непровар, брызги" /></div>
        <div><label className={labelCls}>Примечание</label>
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="замечания оператора" /></div>
      </div>

      <button onClick={save}
        className="px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium text-white">
        ➕ Зафиксировать операцию
      </button>

      <div>
        <h4 className="text-sm font-semibold text-white mb-2">Операции этой станции ({ops.length})</h4>
        {ops.length === 0 && <p className="text-xs text-slate-500">Пока нет записей.</p>}
        <div className="space-y-2">
          {ops.map((o, i) => (
            <div key={i} className="bg-slate-900 border border-slate-800 rounded p-2 text-xs text-slate-300">
              <span className="text-white font-medium">Вход {o.qtyIn} → годных {o.qtyOut}</span>, брак {o.qtyScrap}
              {Object.entries(o.params).length > 0 && <> · {Object.entries(o.params).map(([k, v]) => `${k}: ${v}`).join(' · ')}</>}
              {o.defects.length > 0 && <><br /><span className="text-red-400">⚠ Дефекты: {o.defects.join(', ')}</span></>}
              {o.note && <><br /><span className="text-slate-500">📝 {o.note}</span></>}
              <br /><span className="text-slate-600">{o.finishedAt ? new Date(o.finishedAt).toLocaleString() : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
