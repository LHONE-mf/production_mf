import React,{useState} from 'react';
import {ConfirmedStorage} from './ConfirmedStorage';
import {InventoryIssues} from './InventoryIssues';
import {StorageRegister} from './StorageRegister';
import {OfflineReceivingSync} from './OfflineReceivingSync';
import {StageRoom} from '../_common/StageRoom';
import {RoomTabs} from '../_common/RoomTabs';
import {StageId} from '../../core/types';

type WarehouseTab='receipts'|'issues'|'inventory';

/** Keep operator forms mounted when tabs change: unfinished drafts must survive. */
export function StorageModule(){
 const [tab,setTab]=useState<WarehouseTab>('receipts');
 const [showLocalRegister,setShowLocalRegister]=useState(false);
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
       <section aria-label="Запись поступления без сервера" className="space-y-2 rounded border border-slate-600 p-3">
         <p className="text-sm text-slate-200">Поступление можно записать без подключения, а затем автоматически синхронизировать после подтверждённого входа на сервер. До серверного подтверждения запас не меняется.</p>
         <button type="button" aria-expanded={showLocalRegister} aria-controls="local-storage-receipt-register"
           className="min-h-11 w-full rounded bg-blue-700 px-3 py-2 text-sm font-semibold text-white"
           onClick={()=>setShowLocalRegister(open=>!open)}>{showLocalRegister?'Свернуть локальные поступления':'Добавить локальное поступление для синхронизации'}</button>
       </section>
     </>}
     {tab==='issues'&&<p className="text-sm text-slate-300">Выдавайте материалы конкретной производственной партии. Это не окончательный расход: фактический расход фиксируется в «Замесы → Остатки и расход» по сохранённым навескам и полученным лотам.</p>}
     <div hidden={tab==='issues'}><ConfirmedStorage mode={tab==='inventory'?'inventory':'receipts'}/></div>
     <div hidden={tab!=='issues'}><InventoryIssues/></div>
     <div id="local-storage-receipt-register" hidden={tab!=='receipts'||!showLocalRegister}>
       <OfflineReceivingSync/>
       <details className="mt-3 rounded border border-slate-700 p-3">
         <summary className="min-h-11 cursor-pointer py-2 text-sm">Старый исторический журнал (не синхронизируется автоматически)</summary>
         <StorageRegister/>
       </details>
     </div>
   </div>} preserveToolDraft/>;
}
