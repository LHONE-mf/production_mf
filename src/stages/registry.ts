// Реестр этапов производства («комнат»).
// Точка подключения: добавил папку комнаты + строчку здесь → комната появилась в интерфейсе.
// Комнаты НЕ импортируют друг друга — только core / shared / stages/_common.

import { StageId } from '../core/types';

export interface StageMeta {
  id: StageId;
  title: string;        // название комнаты
  icon: string;         // emoji-иконка для навигации
  tools: string[];      // инструменты комнаты (для описания/подсказок)
}

export const STAGES: StageMeta[] = [
  { id: StageId.STORAGE,     title: 'Склад материалов',        icon: '📦', tools: ['Учёт партий', 'Запасы', 'Журнал', 'Комментарии'] },
  { id: StageId.SLURRY,      title: 'Комната замесов',            icon: '🧪', tools: ['Расчёт граммовок', 'База замесов', 'База компонентов', 'Журнал замеса', 'Комментарии'] },
  { id: StageId.COATING,     title: 'Нанесение покрытия',      icon: '🖌️', tools: ['Данные замесов', 'Расчёт зазора фильеры и шнека', 'Журнал нанесения (6 печей, режимы)', 'Комментарии'] },
  { id: StageId.CALENDARING, title: 'Каландрирование',         icon: '🔄', tools: ['Расчёт обжатия', 'Журнал', 'Комментарии'] },
  { id: StageId.SORTING,     title: 'Сортировка',              icon: '✂️', tools: ['Размеры пластин', 'Дефекты', 'Журнал', 'Комментарии'] },
  { id: StageId.ASSEMBLY,    title: 'Сборка элементов',        icon: '🔋', tools: ['Порядок сборки', 'Контроль полярности', 'Журнал', 'Комментарии'] },
  { id: StageId.ELECTROLYTE, title: 'Розлив электролита',      icon: '💧', tools: ['Дозировка', 'Выдержка', 'Журнал', 'Комментарии'] },
  { id: StageId.FORMATION,   title: 'Формирование (ЧЦЦ)',      icon: '⚡', tools: ['Профили ЦЦ', 'Токи/напряжения', 'Журнал', 'Комментарии'] },
  { id: StageId.AGING,       title: 'Старение',                icon: '⏳', tools: ['Таблица старения', 'Отбор брака', 'Журнал', 'Комментарии'] },
];

export function getStageMeta(id: StageId): StageMeta {
  return STAGES.find((s) => s.id === id) ?? STAGES[0];
}
