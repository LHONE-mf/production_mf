import {db} from './index';
import {UserRole} from '../types';

// A device-local, user-initiated recovery archive. No network operations, server
// authorizations, automatic sync or mutation of saved manufacturing observations.
const FORMAT='production-mf-local-backup';
const VERSION=1;
const MAX_ARCHIVE_CHARS=80_000_000;
const MAX_DEPTH=80;

type Packed =
  | null | string | number | boolean
  | {t:'undefined'}
  | {t:'number';v:string}
  | {t:'date';v:string}
  | {t:'buffer'|'bytes';v:string}
  | {t:'blob';v:string;mime:string}
  | {t:'array';v:Packed[]}
  | {t:'object';v:[string,Packed][]};

function toBase64(bytes:Uint8Array):string {
  let raw='';
  for(let offset=0;offset<bytes.length;offset+=0x8000)
    raw+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  return btoa(raw);
}

function fromBase64(value:unknown):Uint8Array {
  if(typeof value!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error('Некорректные бинарные данные резервной копии');
  const raw=atob(value);
  const bytes=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);
  return bytes;
}

async function pack(value:unknown,depth=0):Promise<Packed>{
  if(depth>MAX_DEPTH)throw new Error('Слишком глубокая структура локальных данных');
  if(value===null||typeof value==='string'||typeof value==='boolean')return value;
  if(typeof value==='number')
    return Number.isFinite(value)?value:{t:'number',v:String(value)};
  if(value===undefined)return {t:'undefined'};
  if(value instanceof Date){
    if(!Number.isFinite(value.getTime()))throw new Error('Некорректная дата в локальной базе');
    return {t:'date',v:value.toISOString()};
  }
  if(value instanceof ArrayBuffer)return {t:'buffer',v:toBase64(new Uint8Array(value))};
  if(value instanceof Uint8Array)return {t:'bytes',v:toBase64(value)};
  if(value instanceof Blob)return {t:'blob',v:toBase64(new Uint8Array(await value.arrayBuffer())),mime:value.type};
  if(Array.isArray(value))return {t:'array',v:await Promise.all(value.map(item=>pack(item,depth+1)))};
  if(typeof value==='object'){
    if(ArrayBuffer.isView(value)||!([Object.prototype,null] as unknown[]).includes(Object.getPrototypeOf(value))||
       Object.getOwnPropertySymbols(value).length)
      throw new Error('Неподдерживаемый тип локальных данных: экспорт отменён');
    const entries:[string,Packed][]=[];
    for(const [key,entry] of Object.entries(value))entries.push([key,await pack(entry,depth+1)]);
    return {t:'object',v:entries};
  }
  throw new Error('Неподдерживаемый тип локальных данных: экспорт отменён');
}

function unpack(value:unknown,depth=0):unknown{
  if(depth>MAX_DEPTH)throw new Error('Слишком глубокая структура резервной копии');
  if(value===null||typeof value==='string'||typeof value==='boolean'||typeof value==='number')
    return value;
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Некорректная структура резервной копии');
  const item=value as Record<string,unknown>;
  if(item.t==='undefined')return undefined;
  if(item.t==='number'&&typeof item.v==='string'&&['NaN','Infinity','-Infinity'].includes(item.v))
    return Number(item.v);
  if(item.t==='date'&&typeof item.v==='string'){
    const date=new Date(item.v);
    if(!Number.isFinite(date.getTime())||date.toISOString()!==item.v)throw new Error('Некорректная дата');
    return date;
  }
  if(item.t==='buffer')return fromBase64(item.v).buffer;
  if(item.t==='bytes')return fromBase64(item.v);
  if(item.t==='blob'&&typeof item.mime==='string')return new Blob([fromBase64(item.v).buffer as ArrayBuffer],{type:item.mime});
  if(item.t==='array'&&Array.isArray(item.v))return item.v.map(part=>unpack(part,depth+1));
  if(item.t==='object'&&Array.isArray(item.v)){
    const obj:Record<string,unknown>={};
    for(const pair of item.v){
      if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||
         Object.prototype.hasOwnProperty.call(obj,pair[0]))
        throw new Error('Некорректное поле резервной копии');
      Object.defineProperty(obj,pair[0],{value:unpack(pair[1],depth+1),enumerable:true,writable:true,configurable:true});
    }
    return obj;
  }
  throw new Error('Неизвестный формат значения в резервной копии');
}

async function sha256(text:string):Promise<string>{
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}

function tableNames():string[]{return db.tables.map(table=>table.name).sort();}

/** Consistent read-only snapshot across every IndexedDB table; includes unsent
 * work for archival purposes but does not grant its restoration to a new device. */
export async function exportLocalBackup(actorId?:string):Promise<string>{
  await db.open();
  const names=tableNames();
  const snapshot=await db.transaction('r',db.tables,async()=>{
    if(actorId!==undefined){const actor=await db.users.get(actorId);if(!actor?.isActive||actor.role!==UserRole.CHIEF)throw Error('Экспорт копии требует активного локального начальника');}
    const rows:unknown[][]=[];
    for(const name of names)rows.push(await db.table(name).toArray());
    return rows;
  });
  const tables:[string,Packed[]][]=[];
  for(let i=0;i<names.length;i++)tables.push([names[i],await Promise.all(snapshot[i].map(row=>pack(row)))]);
  const payload={tables};
  const digest=await sha256(JSON.stringify(payload));
  const archive=JSON.stringify({
    format:FORMAT,version:VERSION,database:db.name,schemaVersion:db.verno,
    createdAt:new Date().toISOString(),payload,sha256:digest,
  });
  if(archive.length>MAX_ARCHIVE_CHARS)throw new Error('Копия слишком велика для безопасного экспорта на этом устройстве');
  return archive;
}

export type LocalBackupInspection={
  createdAt:string;
  tableCount:number;
  recordCount:number;
  userCount:number;
};

/** Parse and verify a chosen archive without changing any saved work.
 * Reuse this exact validation path for a later empty-database restore. */
async function readLocalBackup(text:string):Promise<{
  restored:Map<string,Record<string,unknown>[]>;
  summary:LocalBackupInspection;
}>{
  if(typeof text!=='string'||text.length>MAX_ARCHIVE_CHARS)
    throw new Error('Файл резервной копии слишком велик');
  let value:unknown;
  try{value=JSON.parse(text);}catch{throw new Error('Некорректный JSON резервной копии');}
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw new Error('Неизвестный формат резервной копии');
  const archive=value as Record<string,unknown>;
  await db.open();
  if(archive.format!==FORMAT||archive.version!==VERSION||
     archive.database!==db.name||archive.schemaVersion!==db.verno||
     typeof archive.sha256!=='string')
    throw new Error('Формат или версия базы не подходят этому приложению');
  const payload=archive.payload as {tables?:unknown}|undefined;
  if(!payload||!Array.isArray(payload.tables))throw new Error('Не хватает таблиц резервной копии');
  const rows=payload.tables as unknown[];
  const names=tableNames();
  if(rows.length!==names.length)throw new Error('Неполный набор таблиц резервной копии');
  for(let i=0;i<names.length;i++){
    const entry=rows[i];
    if(!Array.isArray(entry)||entry.length!==2||entry[0]!==names[i]||!Array.isArray(entry[1]))
      throw new Error('Набор таблиц не соответствует текущей базе');
  }
  if(await sha256(JSON.stringify(payload))!==archive.sha256)
    throw new Error('Контрольная сумма резервной копии не совпала');
  const restored=new Map<string,Record<string,unknown>[]>();
  for(const row of rows){
    const [name,values]=row as [string,unknown[]];
    const decoded=values.map(item=>unpack(item));
    if(decoded.some(item=>!item||typeof item!=='object'||Array.isArray(item)))
      throw new Error('Некорректные записи таблицы '+name);
    restored.set(name,decoded as Record<string,unknown>[]);
  }
  const restricted=['hybridTaskOutbox','hybridTaskRevisions','hybridTaskResolutions',
    'hybridTaskEditLeases','hybridTaskDeferred','hybridSyncMetadata'];
  if(restricted.some(name=>(restored.get(name)?.length??0)>0))
    throw new Error('Архив содержит серверную синхронизацию. Перенос на другое устройство требует отдельной безопасной процедуры');
  if(!restored.get('users')?.length)throw new Error('В резервной копии нет локальных пользователей');
  const createdAt=archive.createdAt;
  if(typeof createdAt!=='string'){
    throw new Error('В резервной копии отсутствует дата создания');
  }
  const date=new Date(createdAt);
  if(!Number.isFinite(date.getTime())||date.toISOString()!==createdAt)
    throw new Error('Некорректная дата создания резервной копии');
  return {restored,summary:{
    createdAt,
    tableCount:names.length,
    recordCount:Array.from(restored.values()).reduce((total,items)=>total+items.length,0),
    userCount:restored.get('users')!.length,
  }};
}

/** Check the saved file's content, format and checksum without importing it.
 * This is not a restoration test, authentication of its creator or proof of
 * external storage; a full restore must still be tested on a separate device. */
export async function inspectLocalBackup(text:string):Promise<LocalBackupInspection>{
  return (await readLocalBackup(text)).summary;
}

/** Restore only into a completely empty, same-schema installation. Never
 * resurrect remote authorization, device binding or pending shared task edits.
 * All local writes either commit together or are rolled back. */
export async function restoreLocalBackup(text:string):Promise<void>{
  const {restored}=await readLocalBackup(text);
  const names=tableNames();
  await db.transaction('rw',db.tables,async()=>{
    for(const name of names)
      if(await db.table(name).count())throw new Error('Восстановление возможно только в полностью пустую локальную базу');
    for(const name of names){
      const values=restored.get(name)!;
      if(values.length)await db.table(name).bulkAdd(values);
    }
  });
}
