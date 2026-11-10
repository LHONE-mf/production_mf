import type { CalenderRun, CoatRun, CutRun, JournalEntry, MixBatch } from '../types';
import type { LocalSourceKind, LocalSourceMeasure } from './planningClient';

export type LocalSourceCandidate = {
  key: string; sourceKind: LocalSourceKind; sourceEntryId: string;
  sourceStage: string; sourceCreatedAt: string;
  summary: string; defects?: string; sourceMeasure?: LocalSourceMeasure;
};

const isUuid = (id:unknown): id is string =>
  typeof id === 'string' &&
  /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(id);

function time(value:unknown): string | null {
  if (!(value instanceof Date) && typeof value !== 'number' && typeof value !== 'string')
    return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function bounded(value:unknown): string | null {
  if (typeof value !== 'string') return null;
  const result = value.trim();
  return result.length > 0 && result.length <= 2000 ? result : null;
}

/** Do not infer production output from historical fields or use floating-point
 * arithmetic for cross-stage reconciliation. A metric is merely the locally
 * reported value, explicitly labelled in the UI and stored as numeric(18,6).
 */
function reported(kind:LocalSourceMeasure['kind'],value:unknown):
  LocalSourceMeasure | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      value <= 0 || value >= 1e12) return undefined;
  const rounded = value.toFixed(6);
  return Number(rounded) > 0 ? {kind,value:rounded} : undefined;
}

/** Only expressly selected, user-created UUID records are eligible.
 * UUID format does not establish whether a record is authentic or physical.
 * No automatic upload, local mutation, or source-data validation occurs.
 */
export function localSourceCandidates(
  journal:JournalEntry[],mixes:MixBatch[],coatings:CoatRun[],
  calenders:CalenderRun[] = [], cuts:CutRun[] = [],
): LocalSourceCandidate[] {
  const items:LocalSourceCandidate[] = [];
  for (const e of journal) {
    if (!e || !isUuid(e.id) || typeof e.stage !== 'string') continue;
    const at=time(e.createdAt), summary=bounded(e.summary);
    if (!at || !summary || (e.defects!=null && typeof e.defects!=='string') ||
      (e.defects?.trim().length ?? 0)>2000) continue;
    items.push({
      key:'journal:'+e.id,sourceKind:'journal',sourceEntryId:e.id,
      sourceStage:e.stage,sourceCreatedAt:at,summary,
      ...(e.defects?.trim()?{defects:e.defects.trim()}:{}),
    });
  }
  for(const m of mixes) {
    if (!m || !isUuid(m.id)) continue;
    const at=time(m.createdAt), recipe=bounded(m.recipeName);
    if (!at || !recipe) continue;
    const summary=bounded('Замес: '+recipe);
    if (!summary) continue;
    const measure=reported('dry_solids_kg',m.batchKg);
    items.push({
      key:'mix_batch:'+m.id,sourceKind:'mix_batch',sourceEntryId:m.id,
      sourceStage:'slurry',sourceCreatedAt:at,summary,
      ...(measure?{sourceMeasure:measure}:{}),
    });
  }
  for(const c of coatings) {
    if (!c || !isUuid(c.id)) continue;
    const at=time(c.createdAt);
    if (!at) continue;
    const foil = typeof c.foilType === 'string' && c.foilType.trim()
      ? c.foilType.trim() : 'фольга не указана';
    const summary=bounded('Нанесение покрытия: '+foil);
    if (!summary || (c.defects!=null && typeof c.defects!=='string') ||
      (c.defects?.trim().length ?? 0)>2000) continue;
    const measure=reported('coated_side_a_m',c.sideALengthM);
    items.push({
      key:'coat_run:'+c.id,sourceKind:'coat_run',sourceEntryId:c.id,
      sourceStage:'coating',sourceCreatedAt:at,summary,
      ...(c.defects?.trim()?{defects:c.defects.trim()}:{}),
      ...(measure?{sourceMeasure:measure}:{}),
    });
  }
  for (const c of calenders) {
    if (!c || !isUuid(c.id)) continue;
    const at=time(c.createdAt);
    const roll=typeof c.rollId==='string' && c.rollId.trim()
      ? c.rollId.trim().slice(0,200) : 'не указан';
    const summary=bounded('Каландрирование: рулон '+roll);
    if (!at || !summary || (c.defects!=null && typeof c.defects!=='string') ||
      (c.defects?.trim().length ?? 0)>2000) continue;
    const measure=reported('calendered_length_m',c.totalLengthM);
    items.push({
      key:'calender_run:'+c.id,sourceKind:'calender_run',sourceEntryId:c.id,
      sourceStage:'calendaring',sourceCreatedAt:at,summary,
      ...(c.defects?.trim()?{defects:c.defects.trim()}:{}),
      ...(measure?{sourceMeasure:measure}:{}),
    });
  }
  for (const c of cuts) {
    if (!c || !isUuid(c.id)) continue;
    const at=time(c.createdAt);
    const shape=typeof c.electrodeType==='string'
      ? c.electrodeType.slice(0,80) : 'не указан';
    const summary=bounded('Нарезка электродов: '+shape);
    if (!at || !summary || (c.defects!=null && typeof c.defects!=='string') ||
      (c.defects?.trim().length ?? 0)>2000) continue;
    // A reported count must not silently round a fractional/invalid value.
    const measure=Number.isSafeInteger(c.goodCount)
      ? reported('cut_good_pieces',c.goodCount) : undefined;
    items.push({
      key:'cut_run:'+c.id,sourceKind:'cut_run',sourceEntryId:c.id,
      sourceStage:'cutting',sourceCreatedAt:at,summary,
      ...(c.defects?.trim()?{defects:c.defects.trim()}:{}),
      ...(measure?{sourceMeasure:measure}:{}),
    });
  }
  return items.sort((a,b)=>b.sourceCreatedAt.localeCompare(a.sourceCreatedAt));
}

export const localKindLabels:Record<LocalSourceKind,string> = {
  journal:'Журнал работ', mix_batch:'Журнал замесов',
  coat_run:'Журнал нанесения',
  calender_run:'Журнал каландрирования',cut_run:'Журнал нарезки',
};
export const metricLabels:Record<LocalSourceMeasure['kind'],string> = {
  dry_solids_kg:'Заявленная масса сухих веществ, кг',
  coated_side_a_m:'Заявленная длина покрытия, сторона A, м',
  calendered_length_m:'Заявленная прокатанная длина, м',
  cut_good_pieces:'Заявлено годных после нарезки, шт',
};
