import React from 'react';
import type {AssemblyOperationUnits,AssemblyQuantityUnit} from '../../core/types';
export const ASSEMBLY_UNIT_LABELS:Record<AssemblyQuantityUnit,string>={parts:'детали',electrodes:'электроды',sets:'комплекты',blocks:'блоки',cells:'ячейки'};
export function AssemblyOperationUnits({value,onChange,disabled}:{value:AssemblyOperationUnits;onChange:(value:AssemblyOperationUnits)=>void;disabled?:boolean}){
 return <div className="space-y-2">
  <p className="text-xs text-amber-200">Наблюдение станции не подтверждает выпуск ячеек. Укажите единицы каждого количества; пересчёт между ними не выполняется.</p>
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
   {([['input','Единица входа'],['output','Единица выхода'],['scrap','Единица брака']] as const).map(([key,label])=><label key={key} className="text-xs text-slate-300">{label}
    <select disabled={disabled} aria-label={label} className="block min-h-11 w-full bg-slate-900 border border-slate-700 rounded p-2" value={value[key]??''} onChange={e=>onChange({...value,[key]:e.target.value||undefined})}>
     <option value="">— укажите явно —</option>
     {Object.entries(ASSEMBLY_UNIT_LABELS).map(([unit,name])=><option key={unit} value={unit}>{name}</option>)}
    </select>
   </label>)}
  </div>
 </div>;
}
