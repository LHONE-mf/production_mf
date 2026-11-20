import React,{useState} from 'react';
import {ConfirmedStorage} from './ConfirmedStorage';
import {InventoryIssues} from './InventoryIssues';
import {StorageRegister} from './StorageRegister';
import {StageRoom} from '../_common/StageRoom';
import {RoomTabs} from '../_common/RoomTabs';
import {StageId} from '../../core/types';

type WarehouseTab='receipts'|'issues'|'inventory';

/** Three operator-facing workstreams; all historical data and advanced controls survive. */
export function StorageModule(){
 const [tab,setTab]=useState<WarehouseTab>('receipts');
 return <StageRoom stage={StageId.STORAGE} title="Склад" icon="📦"
   description="Поступление материалов и готовых аккумуляторов, выдача материалов в производство, остатки по партиям."
   tool={<div className="min-w-0 space-y-3">
     <RoomTabs label="Разделы склада" activeTab={tab} onChange={setTab} tabs={[
       {id:'receipts',label:'📥 Поступление'},
       {id:'issues',label:'📤 Расход'},
       {id:'inventory',label:'📦 Остатки'},
     ]}/>
     {tab==='receipts'&&<>
       <p className="text-sm text-slate-300">Сырьё и компоненты поступают на склад с партией изготовителя, документами и сроком годности. Готовой продукцией считаются только аккумуляторы и батарейки. Электроды переходят непосредственно на следующий производственный этап.</p>
       <ConfirmedStorage mode="receipts"/>
       <details className="rounded-lg border border-slate-700 p-3">
         <summary className="min-h-11 cursor-pointer py-2 text-sm">Исторический локальный журнал поступлений (без подтверждения остатка)</summary>
         <StorageRegister/>
       </details>
     </>}
     {tab==='issues'&&<>
       <p className="text-sm text-slate-300">Выдавайте материалы конкретной производственной партии. Это не окончательный расход: фактический расход фиксируется в «Замесы → Остатки и расход» по сохранённым навескам и полученным лотам.</p>
       <InventoryIssues/>
     </>}
     {tab==='inventory'&&<ConfirmedStorage mode="inventory"/>}
   </div>} preserveToolDraft/>;
}
