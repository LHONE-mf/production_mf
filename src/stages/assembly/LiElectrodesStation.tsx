// B-с1: Изготовление отрицательных (литиевых) электродов. Отдельный файл — можно
// переписать целиком, не трогая остальные подсекции сборки.
// Оператор фиксирует: сколько заготовок подали, сколько годных электродов получили,
// брак, параметры оборудования и дефекты. Результат добавляется в AssemblyRun.ops.

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

export function LiElectrodesStation({ run, workerId, onAddOp }: Props) {
  const [qtyIn, setQtyIn] = useState('');
  const [qtyOut, setQtyOut] = useState('');
  const [qtyScrap, setQtyScrap] = useState('0');
  const [thickness, setThickness] = useState('');      // толщина литиевого электрода, мкм
  const [defects, setDefects] = useState('');
  const [note, setNote] = useState('');

  const ops = run.ops.filter((o) => o.substation === 'li-electrodes');

  const save = () => {
    const inN = parseInt(qtyIn, 10), outN = parseInt(qtyOut, 10);
    if (!inN || isNaN(outN)) return;
    const op: AssemblyOp = {
      substation: 'li-electrodes',
      workerId,
      finishedAt: new Date().toISOString(),
      qtyIn: inN,
      qtyOut: outN,
      qtyScrap: parseInt(qtyScrap, 10) || 0,
      params: { ...(thickness ? { 'Толщина электрода, мкм': parseFloat(thickness) } : {}) },
      defects: defects.split(',').map((s) => s.trim()).filter(Boolean),
      note: note.trim() || undefined,
    };
    onAddOp(op);
    setQtyIn(''); setQtyOut(''); setQtyScrap('0'); setThickness(''); setDefects(''); setNote('');
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">
        🔘 Изготовление отрицательных электродов из литиевой фольги: вырубка/пробивка пластин
        заданного размера. Партия: <b className="text-white">{run.batchName}</b>
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div><label className={labelCls}>Заготовок подано, шт</label>
          <input className={inputCls} type="number" value={qtyIn} onChange={(e) => setQtyIn(e.target.value)} placeholder="0" /></div>
        <div><label className={labelCls}>Годных электродов, шт</label>
          <input className={inputCls} type="number" value={qtyOut} onChange={(e) => setQtyOut(e.target.value)} placeholder="0" /></div>
        <div><label className={labelCls}>Брак, шт</label>
          <input className={inputCls} type="number" value={qtyScrap} onChange={(e) => setQtyScrap(e.target.value)} /></div>
        <div><label className={labelCls}>Толщина электрода, мкм</label>
          <input className={inputCls} type="number" step="0.1" value={thickness} onChange={(e) => setThickness(e.target.value)} placeholder="напр. 45" /></div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div><label className={labelCls}>Дефекты (через запятую)</label>
          <input className={inputCls} value={defects} onChange={(e) => setDefects(e.target.value)} placeholder="заусенец, окисление, несоосность отверстий" /></div>
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
