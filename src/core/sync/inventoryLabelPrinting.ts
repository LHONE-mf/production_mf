import {Capacitor,registerPlugin} from '@capacitor/core';
import {inventoryLabel,type InventoryLabelKind} from './inventoryIdentification';
const printer=registerPlugin<{printLabel(input:{html:string;jobName:string}):Promise<{dialogOpened:boolean}>}>('InventoryLabelPrinter');
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function inventoryLabelHtml(organizationId:string,kind:InventoryLabelKind,id:string,caption:string,svg:string){
 const label=inventoryLabel(organizationId,kind,id);if(typeof caption!=='string'||caption.length>500||typeof svg!=='string'||svg.length>30000)throw Error('Invalid label content');
 const parsed=new DOMParser().parseFromString(svg,'image/svg+xml'),root=parsed.documentElement;
 if(root.tagName!=='svg'||parsed.querySelector('parsererror'))throw Error('Invalid QR SVG');
 const tags=new Set(['svg','path','rect','g','title','desc']),attrs=new Set(['xmlns','width','height','viewBox','fill','d','x','y','role','shape-rendering','aria-label','aria-labelledby','id']);
 for(const node of [root,...root.querySelectorAll('*')]){if(!tags.has(node.tagName))throw Error('Unsafe label SVG element');for(const attr of [...node.attributes])if(!attrs.has(attr.name)||/url\s*\(|javascript:|https?:|data:/i.test(attr.value)&&attr.name!=='xmlns'||attr.name==='xmlns'&&attr.value!=='http://www.w3.org/2000/svg')throw Error('Unsafe label SVG attribute');}
 const safeSvg=new XMLSerializer().serializeToString(root);
 return`<!doctype html><html lang="ru"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Storage ${kind} ${id}</title><style>@page{size:70mm 90mm;margin:3mm}body{font:12px sans-serif;color:#000;background:#fff;margin:0;overflow-wrap:anywhere}.label{max-width:64mm;padding:2mm}svg{display:block;width:48mm;height:48mm;margin:auto}h1{font-size:14px}code{font-size:10px}</style><div class="label"><h1>${escape(caption)}</h1>${safeSvg}<p>${escape(kind)} · ${escape(id)}</p><code>${escape(label)}</code><p>Идентификатор. Движение требует отдельного разрешения.</p></div></html>`;
}
/** Opens the platform print dialog; never claims paper was printed. */
export async function printInventoryLabel(html:string,jobName:string){
 if(Capacitor.isNativePlatform()){const result=await printer.printLabel({html,jobName});if(!result.dialogOpened)throw Error('Не удалось открыть печать');return;}
 const frame=document.createElement('iframe');frame.title='Этикетка для печати';frame.style.cssText='position:fixed;width:1px;height:1px;opacity:0;pointer-events:none';
 await new Promise<void>((resolve,reject)=>{frame.onload=()=>{try{if(!frame.contentWindow)throw Error('Print frame unavailable');const cleanup=()=>frame.remove();frame.contentWindow.addEventListener('afterprint',cleanup,{once:true});frame.contentWindow.print();setTimeout(cleanup,60000);resolve();}catch(e){frame.remove();reject(e);}};frame.srcdoc=html;document.body.append(frame);});
}
