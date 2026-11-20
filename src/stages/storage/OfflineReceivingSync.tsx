import React,{useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {useAuthStore} from '../../core/store/authStore';
import {useServerConnection} from '../../core/sync/serverConnection';
import {inventoryOutbox} from '../../core/sync/inventoryOutbox';
import {autoSyncLocalReceipts,localReceiptsForUser,saveUnboundReceipt,correctUnboundReceiptMatch,type LocalReceiptFields}
 from '../../core/sync/localWarehouseReceipts';

const empty=():LocalReceiptFields=>({
 materialCode:'',locationPath:'',manufacturerLot:'',quantity:'',unit:'kg',
 reason:'',receiptReference:'',supplier:'',manufacturedOn:'',expiresOn:'',
});
const inputClass='min-h-11 w-full min-w-0 rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white';

export function OfflineReceivingSync(){
 const user=useAuthStore(s=>s.currentUser),connection=useServerConnection();
 const [fields,setFields]=useState<LocalReceiptFields>(empty);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const [matchingId,setMatchingId]=useState<string|null>(null);
 const [matchCode,setMatchCode]=useState(''),[matchPath,setMatchPath]=useState('');
 const records=useLiveQuery(async()=>{
  if(!user)return [];
  const rows=await localReceiptsForUser(user.id);
  return Promise.all(rows.map(async row=>{
   const queue=await inventoryOutbox.operations.get(row.operationId);
   return {...row,queueState:queue?.state,queueError:queue?.error};
  }));
 },[user?.id])??[];
 function edit(name:keyof LocalReceiptFields,value:string){setFields(v=>({...v,[name]:value}));}
 async function save(){
  if(!user||busy)return;
  setBusy(true);setError('');setMessage('');
  try{
   const receipt=await saveUnboundReceipt(user.id,fields);
   setFields(empty());
   setMessage('Локальное поступление '+receipt.operationId+' сохранено. При подтверждённом подключении к серверу будет предпринята автоматическая синхронизация.');
   if(connection)void autoSyncLocalReceipts(connection,user.id).catch(()=>{/* Original remains in local queue. */});
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy(false);}
 }
 async function retry(){
  if(!connection||!user||busy)return;
  setBusy(true);setError('');setMessage('');
  try{await autoSyncLocalReceipts(connection,user.id);setMessage('Проверка очереди завершена. Статусы поступлений обновлены.');}
  catch(cause){setError('Очередь сохранена: '+(cause instanceof Error?cause.message:String(cause)));}
  finally{setBusy(false);}
 }
 async function saveMatch(operationId:string){
  if(!user||busy)return;
  setBusy(true);setError('');
  try{
   await correctUnboundReceiptMatch(user.id,operationId,matchCode,matchPath);
   setMatchingId(null);
   if(connection)void autoSyncLocalReceipts(connection,user.id).catch(()=>{});
  }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}
  finally{setBusy(false);}
 }
 function field(key:keyof LocalReceiptFields,title:string,placeholder?:string){
  return <label className="block space-y-1 text-sm text-slate-200">{title}
   <input className={inputClass} type={key==='manufacturedOn'||key==='expiresOn'?'date':'text'} aria-label={title} value={fields[key]??''} maxLength={key==='reason'?2000:key==='locationPath'?300:200}
    placeholder={placeholder} onChange={e=>edit(key,e.target.value)}/>
  </label>;
 }
 return <section aria-label="Локальная приёмка с синхронизацией" className="space-y-3 rounded border border-blue-600 p-3">
  <h4 className="font-semibold text-white">Поступление без сети → синхронизация с сервером</h4>
  <p className="text-sm text-slate-300">Запись доступна без предварительного подключения. После входа на сервер и проверки устройства приложение автоматически сопоставит материал и место с серверным справочником и отправит поступление с исходным ID. Если совпадение неоднозначно, запись останется для сверки. Серверное поступление создаётся в карантине, а не в доступном для расходования остатке.</p>
  <div className="space-y-3">
   {field('materialCode','Код или точное название материала','Например, PVDF')}
   {field('locationPath','Место склада (название или полный путь)','Например, Склад / Шкаф 2 / Полка 1')}
   {field('manufacturerLot','Партия изготовителя')}
   <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
    {field('quantity','Фактически принятое количество')}
    <label className="block text-sm text-slate-200">Единица измерения
     <select aria-label="Единица измерения" className={inputClass} value={fields.unit}
      onChange={e=>edit('unit',e.target.value)}>
      {['kg','g','mg','L','ml','ul','m','mm','pieces','rolls'].map(unit=><option key={unit} value={unit}>{unit}</option>)}
     </select>
    </label>
   </div>
   <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
    {field('manufacturedOn','Дата изготовления (необязательно)')}
    {field('expiresOn','Годен до (необязательно)')}
   </div>
   {field('supplier','Поставщик (необязательно)')}
   {field('receiptReference','Документ поступления')}
   {field('reason','Основание фактической приёмки')}
   <button type="button" disabled={busy} className="min-h-11 w-full rounded bg-blue-700 px-3 py-2 font-semibold text-white disabled:opacity-40"
    onClick={()=>void save()}>Сохранить поступление для синхронизации</button>
  </div>
  {message&&<p role="status" className="text-sm text-emerald-300">{message}</p>}
  {error&&<p role="alert" className="text-sm text-red-300">{error}</p>}
  <h5 className="font-semibold text-white">Локальная очередь ({records.filter(r=>r.state!=='confirmed').length})</h5>
  {records.map(row=><article key={row.operationId} className="space-y-1 rounded border border-slate-600 p-2 text-sm">
   <p className="font-semibold">{row.materialCode} · {row.manufacturerLot} · {row.quantity} {row.unit}</p>
   {(row.manufacturedOn||row.expiresOn)&&<p className="text-xs text-slate-300">{row.manufacturedOn?'Изготовлено: '+row.manufacturedOn+' · ':''}{row.expiresOn?'Годен до: '+row.expiresOn:''}</p>}
   <p className="break-all text-xs text-slate-400">Операция: {row.operationId}</p>
   <p>{row.state==='confirmed'?'Подтверждено сервером (карантин)':row.state==='needs_review'?'Требуется сверка':
    row.queueState==='conflict'?'Конфликт сервера — не отправлять повторно':
    row.queueState==='rejected'?'Отклонено сервером — проверьте реквизиты':
    row.state==='queued'?'Ожидает подтверждения сервера':'Ожидает подключения'}</p>
   {(row.error||row.queueError)&&<p className="text-amber-200">{row.queueError??row.error}</p>}
   {row.state==='needs_review'&&!row.boundScopeKey&&<button type="button" className="min-h-11 rounded bg-amber-700 px-3 text-white"
    onClick={()=>{setMatchingId(row.operationId);setMatchCode(row.matchMaterialCode??row.materialCode);setMatchPath(row.matchLocationPath??row.locationPath);}}>
    Уточнить код материала и место для синхронизации
   </button>}
   {matchingId===row.operationId&&<section aria-label="Сверка справочника" className="space-y-2 rounded border border-amber-500 p-2">
    <p>Измерения, партия и исходная запись не изменяются. Введите точные данные из справочника сервера.</p>
    <label className="block">Серверный код материала<input aria-label="Серверный код материала" className={inputClass}
     value={matchCode} onChange={e=>setMatchCode(e.target.value)}/></label>
    <label className="block">Полный путь места<input aria-label="Полный путь места" className={inputClass}
     value={matchPath} onChange={e=>setMatchPath(e.target.value)}/></label>
    <div className="flex flex-wrap gap-2">
     <button type="button" disabled={busy} className="min-h-11 rounded bg-blue-700 px-3 text-white"
      onClick={()=>void saveMatch(row.operationId)}>Сохранить сверку и повторить</button>
     <button type="button" className="min-h-11 rounded bg-slate-700 px-3 text-white"
      onClick={()=>setMatchingId(null)}>Отмена</button>
    </div>
   </section>}
  </article>)}
  {connection&&records.some(row=>row.state!=='confirmed')&&
   <button type="button" disabled={busy} className="min-h-11 rounded bg-slate-700 px-3 py-2 text-white disabled:opacity-40"
    onClick={()=>void retry()}>Повторить синхронизацию ожидающих</button>}
 </section>;
}
