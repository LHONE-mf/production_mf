import React,{useState} from 'react';
import {ConfirmedStorage} from './ConfirmedStorage';
import {InventoryIssues} from './InventoryIssues';
import { StageRoom } from '../_common/StageRoom';
import { StageId } from '../../core/types';

type WarehouseTab='receiving'|'issues'|'inventory';
const sections:{id:WarehouseTab;label:string}[]=[
 {id:'receiving',label:'📥 Поступление'},
 {id:'issues',label:'📤 Выдача / расход'},
 {id:'inventory',label:'📋 Инвентарь'},
];
export function StorageModule(){
 const [tab,setTab]=useState<WarehouseTab>('receiving');
 return <StageRoom stage={StageId.STORAGE} title="Склад" icon="📦"
   description="Поступление сырья и материалов, выдача в производство, фактические остатки. Электроды идут между участками, а не на склад."
   tool={<div className="space-y-3">
     <nav aria-label="Разделы склада" className="grid grid-cols-3 gap-2">
       {sections.map(section=><button key={section.id} type="button"
         aria-current={tab===section.id?'page':undefined}
         className={'min-h-14 rounded-lg border px-2 py-2 text-sm font-semibold '+(tab===section.id?'border-blue-400 bg-blue-900 text-white':'border-slate-600 bg-slate-800 text-slate-200')}
         onClick={()=>setTab(section.id)}>{section.label}</button>)}
     </nav>
     {tab==='receiving'&&<ConfirmedStorage mode="receiving"/>}
     {tab==='issues'&&<><p className="rounded border border-amber-700 p-3 text-sm text-amber-200">Выдача со склада и фактический расход в замесе — разные операции. Здесь оформляется передача материала в конкретную производственную партию; фактический расход фиксируется в замесе. Не списывайте одно и то же дважды.</p><InventoryIssues/></>}
     {tab==='inventory'&&<ConfirmedStorage mode="inventory"/>}
   </div>} preserveToolDraft/>;
}
