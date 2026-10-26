// Роутер комнат этапов производства: tab вида "stage:<id>" → модуль комнаты.
// Каждая комната — независимый модуль из src/stages/<id>.

import React from 'react';
import { StageId } from '../core/types';
import { StorageModule } from './storage/StorageModule';
import { SlurryModule } from './slurry/SlurryModule';
import { CoatingModule } from './coating/CoatingModule';
import { CalendaringModule } from './calendaring/CalendaringRoom';
import { CuttingModule } from './cutting/CuttingRoom';
import { SortingModule } from './sorting/SortingRoom';
import { AssemblyModule } from './assembly/AssemblyRoom';
import { FillRoom } from './electrolyte/FillRoom';
import { WalzingRoom } from './walzing/WalzingRoom';
import { FormationModule } from './formation/FormationModule';
import { AgingModule } from './aging/AgingModule';

const STAGE_COMPONENTS: Record<StageId, React.ComponentType> = {
  [StageId.STORAGE]: StorageModule,
  [StageId.SLURRY]: SlurryModule,
  [StageId.COATING]: CoatingModule,
  [StageId.CALENDARING]: CalendaringModule,
  [StageId.CUTTING]: CuttingModule,
  [StageId.SORTING]: SortingModule,
  [StageId.ASSEMBLY]: AssemblyModule,
  // Две комнаты заливки электролита — одно и то же приложение, разные помещения
  [StageId.ELECTROLYTE]: () => <FillRoom box="dry-room" />,
  [StageId.ELECTROLYTE_705]: () => <FillRoom box="floor7-room5" />,
  [StageId.WALZING]: WalzingRoom,
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
