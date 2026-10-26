// B-с4: Зиговка канта корпуса + точечная сварка токоотвода + ультразвуковая завальцовка
// крышки ЦИЛИНДРИЧЕСКИХ ячеек. Отдельный файл — переписывается независимо.
// Три технологические операции одной станции: зиговка (crimp), точка (spot), УЗ (ultrasonic).

import React, { useState } from 'react';
import { AssemblyOp, AssemblyRun } from '../../core/types';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

type CrimpPhase = 'crimp' | 'spot' | 'us';
const PHASES: { id: CrimpPhase; name: string; hint: string }[] = [
  { id: 'crimp', name: '🔩 Зиговка канта', hint: 'обжим канта стакана под крышку' },
  { id: 'spot', name: '⚡ Точечная сварка', hint: 'приварка токоотвода к блоку/крышке' },
  { id: 'us', name: '🔊 УЗ-завальцовка', hint: 'ультразвуковая герметизация крышки' },
];

interface Props {
  run: AssemblyRun;
  workerId: string;
  onAddOp: (op: AssemblyOp) => void;
}

export function CrimpCylStation({ run, workerId, onAddOp }: Props) {
  const [phase, setPhase] = useState<CrimpPhase>('crimp');
  const [qtyIn, setQtyIn] = useState('');
  const [qtyOut, setQtyOut] = useState('');
  const [qtyScrap, setQtyScrap] = useState('0');
  const [p1, setP1] = useState('');   // параметр 1 (зиг / сила точки / амплитуда УЗ)
  const [p2, setP2] = useState('');   // параметр 2 (угол / время импульса / давление УЗ)
  const [defects, setDefects] = useState('');
  const [note, setNote] = useState('');

  const ops = run.ops.filter((o) => o.substation === 'crimp-cyl');

  const paramLabels: Record<CrimpPhase, [string, string]> = {
    crimp: ['Высота зига, мм', 'Угол зига, °'],
    spot: ['Сила тока точки, А', 'Время импульса, мс'],
    us: ['Амплитуда УЗ, мкм', 'Давление завальцовки, Н'],
  };
  const paramKeys: Record<CrimpPhase, [string, string]> = {
    crimp: ['Высота зига, мм', 'Угол зига, °'],
    spot: ['Ток точечной сварки, А', 'Импульс, мс'],
    us: ['Амплитуда УЗ, мкм', 'Давление УЗ, Н'],
  };

  const save = () => {
    const inN = parseInt(qtyIn, 10), outN = parseInt(qtyOut, 10);
    if (!inN || isNaN(outN)) return;
    const [k1, k2] = paramKeys[phase];
    const params: Record<string, number | string> = { Операция: PHASES.find((p) => p.id === phase)!.name };
    if (p1) params[k1] = parseFloat(p1);
    if (p2) params[k2] = parseFloat(p2);
    const op: AssemblyOp = {
      substation: 'crimp-cyl',
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
    setQtyIn(''); setQtyOut(''); setQtyScrap('0'); setP1(''); setP2(''); setDefects(''); setNote('');
  };

  const [l1, l2] = paramLabels[phase];

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">
        🔩 Обработка цилиндрической ячейки: зиговка канта стакана, точечная сварка токоотвода,
        ультразвуковая завальцовка крышки. Партия: <b className="text-white">{run.batchName}</b>
      </p>

      <div className="flex flex-wrap gap-2">
        {PHASES.map((p) => (
          <button key={p.id} onClick={() => setPhase(p.id)}
            title={p.hint}
            className={`px-3 py-1.5 rounded text-xs font-medium border ${
              phase === p.id
                ? 'bg-blue-600 border-blue-500 text-white'
                : 'bg-slate-900 border-slate-700 text-slate-300 hover:border-slate-500'
            }`}>
            {p.name}
          </button>
        ))}
      </div>
      <p className="text-[11px] text-slate-500">{PHASES.find((p) => p.id === phase)!.hint}</p>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div><label className={labelCls}>Ячеек подано, шт</label>
          <input className={inputCls} type="number" value={qtyIn} onChange={(e) => setQtyIn(e.target.value)} placeholder="0" /></div>
        <div><label className={labelCls}>Годных после операции, шт</label>
          <input className={inputCls} type="number" value={qtyOut} onChange={(e) => setQtyOut(e.target.value)} placeholder="0" /></div>
        <div><label className={labelCls}>Брак, шт</label>
          <input className={inputCls} type="number" value={qtyScrap} onChange={(e) => setQtyScrap(e.target.value)} /></div>
        <div><label className={labelCls}>{l1}</label>
          <input className={inputCls} type="number" step="0.01" value={p1} onChange={(e) => setP1(e.target.value)} /></div>
        <div><label className={labelCls}>{l2}</label>
          <input className={inputCls} type="number" step="0.01" value={p2} onChange={(e) => setP2(e.target.value)} /></div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div><label className={labelCls}>Дефекты (через запятую)</label>
          <input className={inputCls} value={defects} onChange={(e) => setDefects(e.target.value)}
            placeholder="непропай точки, негерметичность зига, разрыв мембраны" /></div>
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
              <span className="text-white font-medium">{String(o.params['Операция'] ?? '')}</span>{' '}
              вход {o.qtyIn} → годных {o.qtyOut}, брак {o.qtyScrap}
              {Object.entries(o.params).filter(([k]) => k !== 'Операция').length > 0 &&
                <> · {Object.entries(o.params).filter(([k]) => k !== 'Операция').map(([k, v]) => `${k}: ${v}`).join(' · ')}</>}
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
