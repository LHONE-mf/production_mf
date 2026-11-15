import {db} from '../db';
import {StageId,UserRole,type JournalEntry} from '../types';

export const STORAGE_UNITS={kg:'кг',g:'г',l:'л',m:'м',pieces:'шт.'} as const;
type StorageUnit=keyof typeof STORAGE_UNITS;
interface StorageAttribution {version:1;id:string;actorId:string;actorRole:UserRole;recordedAt:number;evidence:string;location:string;}
export interface StorageReceipt extends StorageAttribution {
 kind:'receipt';material:string;materialReference?:string;supplier?:string;documentReference?:string;lotCode:string;quantity:number;unit:StorageUnit;
}
export interface StorageLocation extends StorageAttribution {kind:'location';receiptId:string;previousEventId:string;fromLocation:string;}
export type StorageEvent=StorageReceipt|StorageLocation;
export interface RecordedLot {receipt:StorageReceipt;history:StorageEvent[];location?:string;}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const norm=(value:string)=>value.trim().replace(/\s+/g,' ').toLocaleLowerCase('ru-RU');
const text=(value:unknown)=>typeof value==='string'&&!!value.trim()&&value.length<=2000;
export function isStorageJournal(value:unknown):boolean {
 if(!value||typeof value!=='object')return false;
 const row=value as JournalEntry;
 return typeof row.id==='string'&&row.id.startsWith('storage:')||!!row.params&&Object.prototype.hasOwnProperty.call(row.params,'storageEvent');
}
export function validateStorageEvent(event:StorageEvent):void {
 if(!event||event.version!==1||!text(event.id)||!event.id.startsWith('storage:')||!text(event.actorId)||!Object.values(UserRole).includes(event.actorRole)||!Number.isFinite(event.recordedAt)||event.recordedAt<=0||!Number.isFinite(new Date(event.recordedAt).getTime())||!text(event.location)||!text(event.evidence))throw Error('Нужны ID, активный автор/роль, время, место и основание записи');
 const common=['version','id','kind','actorId','actorRole','recordedAt','location','evidence'];
 const fields=event.kind==='receipt'?['material','materialReference','supplier','documentReference','lotCode','quantity','unit']:['receiptId','previousEventId','fromLocation'];
 if(Object.keys(event).some(key=>![...common,...fields].includes(key)))throw Error('Запись содержит неизвестные поля; количество и единица при смене места не изменяются');
 if(event.kind==='receipt'){
  if(!text(event.material)||!text(event.lotCode)||typeof event.quantity!=='number'||!Number.isFinite(event.quantity)||event.quantity<=0||!Object.prototype.hasOwnProperty.call(STORAGE_UNITS,event.unit)||event.unit==='pieces'&&!Number.isSafeInteger(event.quantity))throw Error('Укажите материал, партию, положительное количество и единицу; штуки — целые');
  for(const value of [event.materialReference,event.supplier,event.documentReference])if(value!==undefined&&!text(value))throw Error('Неизвестные реквизиты оставьте пустыми, известные укажите явно');
 }else if(event.kind!=='location'||!text(event.receiptId)||!text(event.previousEventId)||!text(event.fromLocation)||norm(event.fromLocation)===norm(event.location))throw Error('Смена места требует исходного события и нового места');
}
export function toStorageJournal(event:StorageEvent):JournalEntry {
 validateStorageEvent(event);
 return {id:event.id,stage:StageId.STORAGE,workerId:event.actorId,createdAt:new Date(event.recordedAt),summary:event.kind==='receipt'?`Записанное поступление: ${event.material}; партия ${event.lotCode}`:`Записанное место: ${event.fromLocation} → ${event.location}`,params:{storageEvent:JSON.stringify(event),'Учёт':'Записанные поступления/история; остаток не подтверждён'}};
}
function parseJournal(row:JournalEntry):StorageEvent {
 const event=JSON.parse(String(row.params?.storageEvent)) as StorageEvent;validateStorageEvent(event);
 const expected=toStorageJournal(event);
 if(!same({...row,createdAt:new Date(row.createdAt)},expected))throw Error('Автор, время, этап и содержание журнала не совпадают со снимком');
 return event;
}
function duplicateLot(a:StorageReceipt,b:StorageReceipt):boolean {
 const material=norm(a.material)===norm(b.material)||!!a.materialReference&&!!b.materialReference&&norm(a.materialReference)===norm(b.materialReference);
 return material&&norm(a.lotCode)===norm(b.lotCode)&&(!a.supplier||!b.supplier||norm(a.supplier)===norm(b.supplier));
}
/** Derive recorded history only. No inventory totals, conversions or consumption. */
export function inspectStorageJournal(rows:JournalEntry[]):{lots:RecordedLot[];problems:string[]} {
 const events:StorageEvent[]=[];const problems:string[]=[];
 for(const row of rows)if(isStorageJournal(row))try{events.push(parseJournal(row));}catch{problems.push(`${row.id}: повреждённая или неоднозначная запись`);}
 const receipts=events.filter((e):e is StorageReceipt=>e.kind==='receipt');
 const moves=events.filter((e):e is StorageLocation=>e.kind==='location');
 const lots=receipts.map(receipt=>{
  const history:StorageEvent[]=[receipt];let current:StorageEvent=receipt;let valid=true;
  if(receipts.some(other=>other.id!==receipt.id&&duplicateLot(receipt,other))){problems.push(`${receipt.id}: повтор материала/партии с тем же или неизвестным поставщиком`);valid=false;}
  const related=moves.filter(e=>e.receiptId===receipt.id);
  while(true){
   const next=related.filter(e=>e.previousEventId===current.id);
   if(!next.length)break;
   if(next.length!==1||history.some(e=>e.id===next[0].id)||next[0].fromLocation!==current.location||next[0].recordedAt<current.recordedAt){valid=false;break;}
   current=next[0];history.push(current);
  }
  if(history.length!==related.length+1)valid=false;
  if(!valid)problems.push(`${receipt.id}: место требует проверки истории`);
  return {receipt,history,location:valid?current.location:undefined};
 });
 for(const move of moves)if(!receipts.some(r=>r.id===move.receiptId))problems.push(`${move.id}: исходное поступление отсутствует`);
 return {lots:lots.sort((a,b)=>b.receipt.recordedAt-a.receipt.recordedAt),problems};
}
async function insertJournal(row:JournalEntry):Promise<StorageEvent> {
 const event=parseJournal(row);const old=await db.journal.get(row.id);
 if(old){if(same({...old,createdAt:new Date(old.createdAt)},{...row,createdAt:new Date(row.createdAt)}))return event;throw Error('ID уже записан; история и исходное намерение не заменяются');}
 const rows=await db.journal.toArray();const result=inspectStorageJournal([...rows,row]);
 if(result.problems.length)throw Error(`Запись не сохранена: ${result.problems[0]}. Проверьте партию/поставщика и последнее место; старая история сохранена`);
 await db.journal.add({...row,createdAt:new Date(row.createdAt)});return event;
}
export async function saveStorageEvent(event:StorageEvent,actorId:string):Promise<StorageEvent> {
 return db.transaction('rw',[db.users,db.journal],async()=>{
  const actor=await db.users.get(actorId);
  if(!actor?.isActive||actor.id!==event.actorId||actor.role!==event.actorRole)throw Error('Нужен активный локальный профиль автора; серверные полномочия этим не предоставляются');
  return insertJournal(toStorageJournal(event));
 });
}
export async function receiveStorageJournal(row:JournalEntry,stage?:StageId,role?:UserRole,senderId?:string):Promise<StorageEvent> {
 return db.transaction('rw',db.journal,async()=>{
  const event=parseJournal(row);
  if(stage!==StageId.STORAGE||role!==UserRole.MASTER&&role!==UserRole.CHIEF&&(senderId!==event.actorId||role!==event.actorRole))throw Error('Этап или подписант не совпадает с автором записи');
  return insertJournal(row);
 });
}

export interface StorageHistoryPacket {
 storageHistoryVersion:1;receiptId:string;latestEventId:string;entries:JournalEntry[];
 exportedBy:string;exportedRole:UserRole;exportedAt:number;
}
export const isStorageHistory=(value:unknown):boolean=>!!value&&typeof value==='object'&&'storageHistoryVersion' in value;
function validateStorageHistory(value:unknown):asserts value is StorageHistoryPacket {
 const packet=value as StorageHistoryPacket;
 if(!packet||packet.storageHistoryVersion!==1||!text(packet.receiptId)||!text(packet.latestEventId)||!text(packet.exportedBy)||!Object.values(UserRole).includes(packet.exportedRole)||!Number.isFinite(packet.exportedAt)||packet.exportedAt<=0||!Number.isFinite(new Date(packet.exportedAt).getTime())||!Array.isArray(packet.entries)||!packet.entries.length)throw Error('Передача требует версию, автора/время и полную сохранённую историю партии');
 const result=inspectStorageJournal(packet.entries);const lot=result.lots[0];
 if(result.problems.length||result.lots.length!==1||lot.receipt.id!==packet.receiptId||lot.history[lot.history.length-1].id!==packet.latestEventId||lot.history.length!==packet.entries.length||lot.history.some((event,i)=>event.id!==packet.entries[i].id))throw Error('Передача должна содержать поступление и всю последовательную историю одной партии без разрывов/ветвлений');
}
/** Read-only export rechecks the viewed snapshot; it never updates event times. */
export async function exportStorageHistory(expected:StorageEvent[],actorId:string):Promise<StorageHistoryPacket> {
 return db.transaction('r',[db.users,db.journal],async()=>{
  const actor=await db.users.get(actorId);if(!actor?.isActive)throw Error('Нужен активный локальный профиль отправителя');
  const result=inspectStorageJournal(await db.journal.toArray());const lot=result.lots.find(row=>row.receipt.id===expected[0]?.id);
  if(result.problems.length||!lot||!same(lot.history,expected))throw Error('Сохранённая история отсутствует, изменилась или требует проверки. Обновите выбор явно');
  const packet:StorageHistoryPacket={storageHistoryVersion:1,receiptId:lot.receipt.id,latestEventId:lot.history[lot.history.length-1].id,entries:lot.history.map(toStorageJournal),exportedBy:actor.id,exportedRole:actor.role,exportedAt:Date.now()};
  validateStorageHistory(packet);return packet;
 });
}
export async function receiveStorageHistory(packet:unknown,stage?:StageId,role?:UserRole,senderId?:string):Promise<void> {
 validateStorageHistory(packet);
 if(stage!==StageId.STORAGE||role!==UserRole.MASTER&&role!==UserRole.CHIEF&&(senderId!==packet.exportedBy||role!==packet.exportedRole))throw Error('Этап или подписант не совпадает с отправителем сохранённой истории');
 await db.transaction('rw',db.journal,async()=>{for(const row of packet.entries)await insertJournal(row);});
}
