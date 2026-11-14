import {inventoryOutbox,queueInventoryReceipt,type InventoryScope,type InventoryReceiptRequest} from './inventoryOutbox';
import type {HybridSession} from './hybridClient';

/** Integer ratios within one physical dimension; reject loss instead of rounding. */
export function toInventoryBaseUnits(quantity:string,unit:string,baseUnit:string):number{
 const units:Record<string,{base:string;factor:bigint}>={mg:{base:'mg',factor:1n},g:{base:'mg',factor:1000n},kg:{base:'mg',factor:1000000n},ul:{base:'ul',factor:1n},ml:{base:'ul',factor:1000n},L:{base:'ul',factor:1000000n},mm:{base:'mm',factor:1n},m:{base:'mm',factor:1000n},pieces:{base:'pieces',factor:1n}};
 const conversion=units[unit],value=quantity.trim().replace(',','.');
 if(!conversion||conversion.base!==baseUnit||!/^\d{1,16}(?:\.\d{1,9})?$/.test(value))throw Error('Введите точное положительное количество в единице материала');
 const [whole,fraction='']=value.split('.'),scale=10n**BigInt(fraction.length);
 const numerator=BigInt(whole+fraction)*conversion.factor;
 if(numerator%scale!==0n)throw Error('Количество нельзя представить в базовой единице без округления');
 const result=numerator/scale;
 if(result<=0n||result>BigInt(Number.MAX_SAFE_INTEGER))throw Error('Количество вне допустимых границ');
 return Number(result);
}
export async function saveReceivingDraft(key:string,expected:number,fields:Record<string,string>){
 return inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,async()=>{
  const prior=await inventoryOutbox.receivingDrafts.get(key);
  if((prior?.revision??0)!==expected||prior?.operationId)throw Error('Черновик изменён или уже поставлен в очередь. Откройте его заново.');
  const row={key,revision:expected+1,fields};await inventoryOutbox.receivingDrafts.put(row);return row;
 });
}
export async function freezeReceivingDraft(key:string,revision:number,session:HybridSession,scope:InventoryScope,request:Omit<InventoryReceiptRequest,'operationId'|'deviceId'>){
 return inventoryOutbox.transaction('rw',inventoryOutbox.receivingDrafts,inventoryOutbox.operations,async()=>{
  const prior=await inventoryOutbox.receivingDrafts.get(key);
  if(!prior||prior.revision!==revision||prior.operationId)throw Error('Черновик изменён или уже подтверждён. Повторная приёмка не создана.');
  const operationId=await queueInventoryReceipt(session,scope,request);
  await inventoryOutbox.receivingDrafts.put({...prior,revision:revision+1,operationId});return operationId;
 });
}
