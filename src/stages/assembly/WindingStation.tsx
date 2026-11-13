import {AssemblyOperationSource} from './AssemblyOperationSource';
import {useAssemblyOperationSave} from './useAssemblyOperationSave';
import {AssemblyOperationUnits,ASSEMBLY_UNIT_LABELS} from './AssemblyOperationUnits';
import {parseAssemblyCounts,ASSEMBLY_COUNT_ERROR} from '../../core/manufacturing/assemblyCounts';
// B-с3: Скрутка цилиндрических блоков электродов (spiral wound «рулон» электрод+сепаратор).
// Отдельный файл — можно переписать целиком, не трогая остальные подсекции сборки.
// Оператор фиксирует: сколько комплектов подали, сколько годных спиральных блоков получили,
// брак, параметры обжимного вала и дефекты. Результат добавляется в AssemblyRun.ops.

import React, { useState } from 'react';
import { AssemblyOp, AssemblyRun } from '../../core/types';

const inputCls =
  'w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500';
const labelCls = 'block text-xs text-slate-400 mb-1';

interface Props {
  run: AssemblyRun;
  workerId: string;
  onAddOp: (op: AssemblyOp) => Promise<void>;
}

export function WindingStation({ run, workerId, onAddOp }: Props) {
  const operation=useAssemblyOperationSave(onAddOp,run);
  const [countError,setCountError]=useState(false);
  const [qtyIn, setQtyIn] = useState('');
  const [qtyOut, setQtyOut] = useState('');
  const [qtyScrap, setQtyScrap] = useState('0');
  const [diameter, setDiameter] = useState('');       // диаметр намотанного блока, мм
  const [tension, setTension] = useState('');         // натяжение ленты, Н
  const [speed, setSpeed] = useState('');             // скорость скрутки, об/мин
  const [defects, setDefects] = useState('');
  const [note, setNote] = useState('');

  const ops = run.ops.filter((o) => o.substation === 'winding');

  const save = async () => {
    const counts=parseAssemblyCounts(qtyIn,qtyOut,qtyScrap);
    setCountError(!counts);
    if(!counts)return;
    const params: Record<string, number | string> = {};
    if (diameter) params['Диаметр блока, мм'] = parseFloat(diameter);
    if (tension) params['Натяжение ленты, Н'] = parseFloat(tension);
    if (speed) params['Скорость скрутки, об/мин'] = parseFloat(speed);
    const op: AssemblyOp = {
      substation: 'winding',
      workerId,
      units:operation.units,
      finishedAt: new Date().toISOString(),
      ...counts,
      params,
      defects: defects.split(',').map((s) => s.trim()).filter(Boolean),
      note: note.trim() || undefined,
    };
    await operation.commit(op,()=>{
    setQtyIn(''); setQtyOut(''); setQtyScrap('0'); setDiameter(''); setTension(''); setSpeed('');
    setDefects(''); setNote('');
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-xs text-slate-400">
        🌀 Скрутка спиральных блоков для цилиндрических ячеек: положительный электрод + сепаратор
        + отрицательный электрод + сепаратор наматываются на оправку. Партия:{' '}
        <b className="text-white">{run.batchName}</b>
      </p>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div><label className={labelCls}>Комплектов подано, шт</label>
          <input disabled={operation.busy} className={inputCls} type="number" value={qtyIn} onChange={(e) => setQtyIn(e.target.value)} placeholder="0" /></div>
        <div><label className={labelCls}>Годных блоков, шт</label>
          <input disabled={operation.busy} className={inputCls} type="number" value={qtyOut} onChange={(e) => setQtyOut(e.target.value)} placeholder="0" /></div>
        <div><label className={labelCls}>Брак, шт</label>
          <input disabled={operation.busy} className={inputCls} type="number" value={qtyScrap} onChange={(e) => setQtyScrap(e.target.value)} /></div>
        <div><label className={labelCls}>Диаметр блока, мм</label>
          <input disabled={operation.busy} className={inputCls} type="number" step="0.01" value={diameter} onChange={(e) => setDiameter(e.target.value)} placeholder="напр. 17.8" /></div>
        <div><label className={labelCls}>Натяжение ленты, Н</label>
          <input disabled={operation.busy} className={inputCls} type="number" step="0.1" value={tension} onChange={(e) => setTension(e.target.value)} placeholder="напр. 12" /></div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div><label className={labelCls}>Скорость скрутки, об/мин</label>
          <input disabled={operation.busy} className={inputCls} type="number" value={speed} onChange={(e) => setSpeed(e.target.value)} placeholder="напр. 600" /></div>
        <div><label className={labelCls}>Дефекты (через запятую)</label>
          <input disabled={operation.busy} className={inputCls} value={defects} onChange={(e) => setDefects(e.target.value)} placeholder="смещение витков, залом, расслаивание" /></div>
        <div><label className={labelCls}>Примечание</label>
          <input disabled={operation.busy} className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} placeholder="замечания оператора" /></div>
      </div>
      <AssemblyOperationSource run={run} form={operation}/>
      <AssemblyOperationUnits disabled={operation.busy} value={operation.units} onChange={operation.setUnits}/>
      {operation.error&&<p role="alert" className="text-red-300 text-sm">{operation.error}</p>}
      {operation.error&&<button disabled={operation.busy} onClick={operation.resetAttempt} className="min-h-11 px-3 bg-slate-800 rounded text-sm">Новая операция</button>}
      {countError&&<p role="alert" className="text-red-300 text-sm">{ASSEMBLY_COUNT_ERROR}</p>}
      <button disabled={operation.busy} onClick={()=>void save()}
        className="min-h-11 px-4 py-2 bg-blue-600 hover:bg-blue-500 rounded text-sm font-medium text-white">
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
              {o.source&&<p className="break-all">Источник: {o.source.kind==='operation'?o.source.operationId:o.source.kind==='intake'?o.source.sortRunId:o.source.reference}{o.conversionNote&&<> · основание: {o.conversionNote}</>}</p>}
              {o.id&&o.units&&<p className="break-all">ID: {o.id} · {o.workerId} · единицы: {o.units.input&&ASSEMBLY_UNIT_LABELS[o.units.input]} → {o.units.output&&ASSEMBLY_UNIT_LABELS[o.units.output]} · брак: {o.units.scrap&&ASSEMBLY_UNIT_LABELS[o.units.scrap]}</p>}
              {o.note && <><br /><span className="text-slate-500">📝 {o.note}</span></>}
              <br /><span className="text-slate-600">{o.finishedAt ? new Date(o.finishedAt).toLocaleString() : ''}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
