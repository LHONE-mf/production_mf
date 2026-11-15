/** Unfinished operator entries only: never an inspection decision or QA record. */
export interface SortingStationDraft {
  passed:string;
  rejected:string;
  grades:Record<string,string>;
  reasonCounts:Record<string,string>;
  notes:string;
}
export interface SortingFormDraft {
  version:1;
  entries:Record<string,SortingStationDraft>;
}
export const emptyStationDraft=():SortingStationDraft=>({
  passed:'',rejected:'',grades:{},reasonCounts:{},notes:'',
});
export const emptySortingDraft=():SortingFormDraft=>({version:1,entries:{}});
export const sortingDraftKey=(workflowId:string,stageIndex:number)=>
  JSON.stringify([workflowId,stageIndex]);

function stringMap(value:unknown):value is Record<string,string>{
  return !!value && typeof value==='object' && !Array.isArray(value) &&
    Object.values(value).every(v=>typeof v==='string');
}
export function parseSortingDraft(value:unknown):SortingFormDraft{
  if(!value || typeof value!=='object')throw new Error('Черновик сортировки повреждён');
  const row=value as Partial<SortingFormDraft>;
  if(row.version!==1 || !row.entries || typeof row.entries!=='object' || Array.isArray(row.entries))
    throw new Error('Неподдерживаемый черновик сортировки');
  for(const entry of Object.values(row.entries)){
    if(!entry || typeof entry!=='object' || typeof entry.passed!=='string' ||
      typeof entry.rejected!=='string' || typeof entry.notes!=='string' ||
      !stringMap(entry.grades) || !stringMap(entry.reasonCounts))
      throw new Error('Черновик сортировки содержит неверные поля');
  }
  return row as SortingFormDraft;
}
