import React from 'react';
import type {AssemblyRun} from '../../core/types';
import type {useAssemblyOperationSave} from './useAssemblyOperationSave';
import {ASSEMBLY_UNIT_LABELS} from './AssemblyOperationUnits';
export function AssemblyOperationSource({run,form}:{run:AssemblyRun;form:ReturnType<typeof useAssemblyOperationSave>}){
 const used=new Set(run.ops.flatMap(op=>op.source?.kind==='operation'?[op.source.operationId]:[]));
 const hasIntake=run.intake&&!run.ops.some(op=>op.source?.kind==='intake');
 return <div className="space-y-2 text-xs text-slate-300">
  <p>Распределяется полный выход одного источника, без разделения. Это записанная связь, не подтверждение движения склада или выпуска.</p>
  <label className="block">Источник операции
   <select aria-label="Источник операции" disabled={form.busy} value={form.sourceChoice} onChange={e=>form.setSourceChoice(e.target.value)} className="block w-full min-h-11 bg-slate-900 border border-slate-700 rounded p-2">
    <option value="">— выберите явно —</option>
    {hasIntake&&<option value="intake">Сортировка {run.intake!.sortRunId}: {run.intake!.electrodeCount} электродов</option>}
    {!run.intake&&<option value="declared">Явно заявленный внешний источник (старая партия)</option>}
    {run.ops.filter(op=>op.id&&op.units?.output&&op.qtyOut>0&&!used.has(op.id)).map(op=><option key={op.id} value={'operation:'+op.id}>{op.substation} · {op.id} · {op.qtyOut} {ASSEMBLY_UNIT_LABELS[op.units!.output!]}</option>)}
   </select>
  </label>
  {form.sourceChoice==='declared'&&<label className="block">Идентификатор внешнего источника
   <input aria-label="Идентификатор внешнего источника" disabled={form.busy} value={form.reference} onChange={e=>form.setReference(e.target.value)} maxLength={160} className="block min-h-11 w-full bg-slate-900 border border-slate-700 rounded p-2"/>
  </label>}
  <label className="block">Основание разных единиц (если отличаются)
   <input aria-label="Основание разных единиц" disabled={form.busy} value={form.conversionNote} onChange={e=>form.setConversionNote(e.target.value)} maxLength={1000} className="block min-h-11 w-full bg-slate-900 border border-slate-700 rounded p-2"/>
  </label>
 </div>;
}
