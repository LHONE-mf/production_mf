import React,{useEffect,useRef,useState} from 'react';
import {QRCodeSVG} from 'qrcode.react';
import {inventoryLabel,type InventoryLabelKind} from '../../core/sync/inventoryIdentification';
import {inventoryLabelHtml,printInventoryLabel} from '../../core/sync/inventoryLabelPrinting';
const labels={container:'контейнера',location:'места хранения',batch:'производственной партии'};
export function InventoryIdentityLabel({organizationId,kind,id,caption}:{organizationId:string;kind:InventoryLabelKind;id:string;caption:string}){
 const value=inventoryLabel(organizationId,kind,id),qr=useRef<HTMLDivElement>(null),[url,setUrl]=useState(''),[message,setMessage]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>()=>{if(url)URL.revokeObjectURL(url);},[url]);
 function document(){const svg=qr.current?.querySelector('svg');if(!svg)throw Error('QR этикетки ещё не готов');return inventoryLabelHtml(organizationId,kind,id,caption,svg.outerHTML);}
 return <details className="space-y-2"><summary className="min-h-11 cursor-pointer py-2">QR / ручной код {labels[kind]}</summary><p>Метка только идентифицирует объект; движение требует отдельного разрешения.</p><div ref={qr} className="inline-block bg-white p-3 text-black"><QRCodeSVG value={value} size={180} title={caption}/></div><p className="break-all" data-inventory-label={value}>{value}</p>
  <button type="button" className="min-h-11 rounded bg-blue-700 px-3" disabled={busy} onClick={()=>{try{const html=document();setUrl(URL.createObjectURL(new Blob([html],{type:'text/html;charset=utf-8'})));setMessage('Этикетка подготовлена. Откройте сохранённый HTML и выберите печать.');}catch(e){setMessage(String(e));}}}>Подготовить этикетку для сохранения</button>
  {url&&<a className="inline-block min-h-11 rounded bg-blue-700 p-2" href={url} download={'Storage-'+kind+'-'+id+'.html'}>Сохранить этикетку HTML</a>}
  <button type="button" className="min-h-11 rounded bg-blue-700 px-3 disabled:opacity-50" disabled={busy} onClick={()=>{setBusy(true);void Promise.resolve().then(()=>printInventoryLabel(document(),'Storage-'+kind+'-'+id)).then(()=>setMessage('Диалог печати открыт. Выберите принтер / PDF и подтвердите печать.')).catch(e=>setMessage(String(e))).finally(()=>setBusy(false));}}>Открыть печать этикетки</button>
  {message&&<p role="status">{message}</p>}
 </details>;
}
export function InventoryPackageLabel({organizationId,stockId}:{organizationId:string;stockId:string}){return <InventoryIdentityLabel organizationId={organizationId} kind="container" id={stockId} caption={'Контейнер '+stockId}/>;}
