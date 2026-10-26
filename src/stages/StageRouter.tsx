// Роутер комнат этапов производства: tab вида "stage:<id>" → модуль комнаты.
// Каждая комната — независимый модуль из src/stages/<id>.

import React from 'react';
import { StageId } from '../core/types';
import { StorageModule } from './storage/StorageModule';
import { SlurryModule } from './slurry/SlurryModule';
import { CoatingModule } from './coating/CoatingModule';
import { CalendaringModule } from './calendaring/CalendaringRoom';
import { SortingModule } from './sorting/SortingModule';
import { AssemblyModule } from './assembly/AssemblyModule';
import { ElectrolyteModule } from './electrolyte/ElectrolyteModule';
import { FormationModule } from './formation/FormationModule';
import { AgingModule } from './aging/AgingModule';

const STAGE_COMPONENTS: Record<StageId, React.ComponentType> = {
  [StageId.STORAGE]: StorageModule,
  [StageId.SLURRY]: SlurryModule,
  [StageId.COATING]: CoatingModule,
  [StageId.CALENDARING]: CalendaringModule,
  [StageId.SORTING]: SortingModule,
  [StageId.ASSEMBLY]: AssemblyModule,
  [StageId.ELECTROLYTE]: ElectrolyteModule,
  [StageId.FORMATION]: FormationModule,
  [StageId.AGING]: AgingModule,
};

/** Если activeTab начинается с "stage:" — возвращаем компонент комнаты, иначе null */
export function renderStageIfActive(activeTab: string): React.ReactNode | null {
  if (!activeTab.startsWith('stage:')) return null;
  const id = activeTab.slice('stage:'.length) as StageId;
  const Comp = STAGE_COMPONENTS[id];
  if (!Comp) return <p className="text-slate-400">Этап «{id}» не найден.</p>;
  return <Comp />;
}
