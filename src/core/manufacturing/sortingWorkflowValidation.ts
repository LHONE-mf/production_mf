import type {SortRun, SortingWorkflow} from '../types';

const whole = (value:unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const label = (value:unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const time = (value:unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;
const order = ['visual', 'thickness', 'mass'] as const;

/** Only completed station decisions are stored here. Unsaved operator forms remain separate. */
export function validateSortingWorkflow(w:SortingWorkflow):void {
  if (!w || !label(w.id) || w.id !== w.cutRunId || !label(w.createdBy) ||
      !time(w.createdAt) || !time(w.updatedAt) ||
      !['pass-fail', 'grading'].includes(w.mode) || !Array.isArray(w.stages) ||
      w.stages.length > order.length)
    throw new Error('Некорректный режим или журнал сортировки');

  const source=w.cutRunSnapshot, spec=w.specSnapshot;
  if (!source || !spec || source.id !== w.cutRunId || !whole(source.goodCount) ||
      source.goodCount === 0 || spec.cutRunId !== source.id ||
      spec.batchName !== source.incomingId || spec.electrodeType !== source.electrodeType ||
      !['strip','prismatic'].includes(source.electrodeType) ||
      !label(spec.id) || !Array.isArray(spec.categories) || spec.categories.length === 0)
    throw new Error('Спецификация и партия нарезки должны совпадать');

  const names=new Set<string>();
  for (const category of spec.categories) {
    if (!category || !label(category.name) || category.name !== category.name.trim() ||
        names.has(category.name))
      throw new Error('Категории спецификации должны иметь уникальные названия');
    names.add(category.name);
    for (const bound of [category.minMass,category.maxMass,category.minUm,category.maxUm])
      if (bound !== undefined && (typeof bound !== 'number' || !Number.isFinite(bound) || bound < 0))
        throw new Error('Границы спецификации должны быть конечными и неотрицательными');
    if (category.minMass !== undefined && category.maxMass !== undefined &&
        category.minMass > category.maxMass)
      throw new Error('Минимальная масса превышает максимальную');
    if (category.minUm !== undefined && category.maxUm !== undefined &&
        category.minUm > category.maxUm)
      throw new Error('Минимальная толщина превышает максимальную');
    if (w.mode === 'grading' && category.minMass === undefined && category.maxMass === undefined)
      throw new Error('Для каждого сорта необходимо указать массовый диапазон');
  }

  let input=source.goodCount;
  for (const [i,stage] of w.stages.entries()) {
    if (!stage || stage.station !== order[i] || !label(stage.workerId) || !time(stage.recordedAt) ||
        !whole(stage.inputCount) || !whole(stage.passedCount) || !whole(stage.rejectedCount) ||
        stage.inputCount !== input ||
        !whole(stage.passedCount+stage.rejectedCount) ||
        stage.passedCount+stage.rejectedCount !== input)
      throw new Error('Станции проходят строго по порядку: визуальный контроль → толщина → масса; баланс должен сходиться');
    if (stage.rejectionReasons !== undefined) {
      if (!Array.isArray(stage.rejectionReasons)) throw new Error('Некорректные причины брака');
      const reasons=new Set<string>();
      let sum=0;
      for (const reason of stage.rejectionReasons) {
        if (!reason || !label(reason.reason) || reasons.has(reason.reason) || !whole(reason.count))
          throw new Error('Некорректные причины брака');
        reasons.add(reason.reason);sum+=reason.count;
      }
      if (!whole(sum) || sum !== stage.rejectedCount)
        throw new Error('Сумма брака по причинам не совпадает с числом отбракованных');
    }
    if (stage.station === 'mass' && w.mode === 'grading') {
      if (!Array.isArray(stage.grades) || stage.grades.length !== names.size)
        throw new Error('Массовая сортировка должна содержать все сорта из КД');
      const seen=new Set<string>();let graded=0;
      for(const grade of stage.grades){
        if (!grade || !names.has(grade.categoryName) || seen.has(grade.categoryName) || !whole(grade.count))
          throw new Error('Сорта не соответствуют КД');
        seen.add(grade.categoryName);graded+=grade.count;
      }
      if (!whole(graded) || graded !== stage.passedCount)
        throw new Error('Количество по сортам не совпадает с годными после взвешивания');
    } else if (stage.grades !== undefined) {
      throw new Error('Сорта назначаются только на массовой станции в режиме градации');
    }
    input=stage.passedCount; // Failed electrodes never move to the next station.
  }
  if (w.finalizedSortRunId !== undefined &&
      (!label(w.finalizedSortRunId) || w.stages.length !== order.length))
    throw new Error('Нельзя завершить сортировку до прохождения всех станций');
}

/** Cross-check a transferable summary against its frozen, three-station decisions. */
export function validateSortingWorkflowOutput(run:SortRun):void {
  const w=run.sortingWorkflow;
  if (!w) return; // Historical one-step summaries are retained without invented station records.
  validateSortingWorkflow(w);
  const mass=w.stages[2];
  if (w.stages.length !== 3 || w.finalizedSortRunId !== run.id ||
      run.cutRunId !== w.cutRunId || run.specId !== w.specSnapshot.id ||
      JSON.stringify(run.cutRunSnapshot) !== JSON.stringify(w.cutRunSnapshot) ||
      JSON.stringify(run.specSnapshot) !== JSON.stringify(w.specSnapshot) ||
      run.goodCount !== w.cutRunSnapshot.goodCount ||
      run.batchName !== w.cutRunSnapshot.incomingId ||
      run.workerId !== mass.workerId ||
      run.rejected !== w.stages.reduce((n,stage)=>n+stage.rejectedCount,0))
    throw new Error('Итог сортировки не соответствует сохранённым станционным записям');

  const expected=w.mode==='grading'
    ? mass.grades!.map(grade=>({categoryName:grade.categoryName,count:grade.count}))
    : [{categoryName:'PASS',count:mass.passedCount}];
  if (run.buckets.length !== expected.length ||
      run.buckets.some((bucket,i)=>bucket.categoryName!==expected[i].categoryName ||
        bucket.count!==expected[i].count || bucket.avgMassG!==undefined || bucket.avgThicknessUm!==undefined))
    throw new Error('Итоговые количества не соответствуют сортировке по массе');
}
