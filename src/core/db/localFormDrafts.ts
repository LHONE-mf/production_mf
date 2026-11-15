import {db} from './index';
export type DraftScope='slurry'|'storage'|'coating'|'sorting';
export interface LocalFormDraft {key:string;actorId:string;scope:DraftScope;version:1;revision:number;updatedAt:number;payload:unknown|null;}
const keyFor=(actorId:string,scope:DraftScope)=>JSON.stringify([actorId,scope]);
function validate(row:LocalFormDraft,actorId:string,scope:DraftScope){
 if(row.version!==1||row.key!==keyFor(actorId,scope)||row.actorId!==actorId||row.scope!==scope||!Number.isSafeInteger(row.revision)||row.revision<=0||!Number.isFinite(row.updatedAt)||row.payload===undefined)throw Error('Версия или структура черновика не поддерживается; сохранённые данные не изменены');
}
export async function loadLocalDraft(actorId:string,scope:DraftScope):Promise<LocalFormDraft|undefined>{
 const row=await db.localFormDrafts.get(keyFor(actorId,scope));if(row)validate(row,actorId,scope);return row;
}
export async function saveLocalDraft(actorId:string,scope:DraftScope,expectedRevision:number,payload:unknown|null):Promise<LocalFormDraft>{
 if(!actorId||!['slurry','storage','coating','sorting'].includes(scope)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||expectedRevision>=Number.MAX_SAFE_INTEGER||payload===undefined)throw Error('Некорректный профиль, комната или версия черновика');
 return db.transaction('rw',[db.users,db.localFormDrafts],async()=>{
  if(!(await db.users.get(actorId))?.isActive)throw Error('Для сохранения черновика нужен активный локальный профиль');
  const old=await loadLocalDraft(actorId,scope);
  if(old?.revision===expectedRevision+1&&JSON.stringify(old.payload)===JSON.stringify(payload))return old;
  if((old?.revision??0)!==expectedRevision)throw Error('Черновик изменён в другом окне. Ваша форма осталась в памяти; сохранённый черновик не заменён');
  const row:LocalFormDraft={key:keyFor(actorId,scope),actorId,scope,version:1,revision:expectedRevision+1,updatedAt:Date.now(),payload};
  // Keep the revision when clearing so a stale window cannot recreate an old draft.
  await db.localFormDrafts.put(row);return row;
 });
}
