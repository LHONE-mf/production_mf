// ============================================================
import { StageId, SerialRange, CellType } from '../index';
// ЭТАПЫ ПРОИЗВОДСТВА («комнаты» цеха). Каждый этап — отдельный
// модуль в src/stages/<id>. Полный офлайн: данные хранятся
// локально, передача только через Bluetooth / QR / текст.
// ============================================================


// Порядок техпроцесса (для навигации и KPI-цепочки)

// ============================================================
// ЗАЛИВКА ЭЛЕКТРОЛИТА. Два разных помещения с одним процессом:
//  - ELECTROLYTE      — бокс сухой комнаты;
//  - ELECTROLYTE_705  — бокс на 7 этаже, комната 5.
// Партии приходят со СБОРКИ (assembly-run). Детали помещений
// опишем позже — структура намеренно расширяемая.
// ============================================================

export interface JournalEntry {
  id: string;
  stage: StageId;
  taskId?: string;          // связь с заданием (если работа по заданию)
  workerId: string;         // кто выполнил
  summary: string;          // что сделано
  params?: Record<string, number | string>; // специфичные параметры этапа
  defects?: string;         // дефекты / брак (пусто = без замечаний)
  createdAt: Date;
}

// ============================================================
// КОМНАТА ЗАМЕСОВ (slurry): компоненты, стандартные замесы,
// режимы замеса, журнал фактических замесов.
// ============================================================

// Компонент замеса из справочной базы (редактируется технологом/мастером)
export interface MixComponent {
  id: string;
  name: string;                  // название (например «LFP», «PVDF», «вода деионизованная»)
  kind: 'active' | 'binder' | 'conductive' | 'solvent' | 'additive'; // тип компонента
  densitySettled?: number;       // плотность утряски, г/см³
  densityTrue?: number;          // истинная плотность, г/см³
  capacity?: number;             // удельная ёмкость, мАч/г (если применимо)
  ssa?: number;                  // удельная площадь поверхности частиц, м²/г (BET)
  d50?: number;                  // D50 — медианный размер частиц, мкм
  viscosity?: number;            // динамическая вязкость чистого компонента (растворителя), мПа·с (сП) при 25°C — для моделей вязкости пасты
  updatedAt: number;             // для разрешения конфликтов при офлайн-синхронизации
}

// Строка рецепта: компонент + доля
export interface MixRecipeLine {
  componentId: string;
  pct: number;                   // % массы (для сухих — от массы СВ; для растворителя — от массы СВ)
}

// Этап режима замеса (скорости диспергатора/лопастей, вакуум, термостат, время)
export interface MixModeStage {
  id: string;
  name: string;                  // например «Диспергирование СВ»
  disperserRpm?: number;         // скорость диспергатора (высокооборотистая мешалка), об/мин
  paddleRpm?: number;            // скорость лопастей (низкооборотистая мешалка), об/мин
  vacuumOn: boolean;             // вакуум включён?
  vacuumKpa?: number;            // глубина вакуума, кПа (если включён)
  tempC?: number;                // температура термостата (чиллера), °C
  minutes: number;               // длительность этапа, мин
}

// Стандартный замес (рецепт + режим) — редактируемая база
export interface MixRecipe {
  id: string;
  name: string;                  // например «Катод LFP R-07»
  dryMassKg: number;             // базовая масса сухих веществ, кг
  lines: MixRecipeLine[];        // строки с выбором компонентов
  mode: MixModeStage[];          // этапы режима замеса
  note?: string;
  updatedBy: string;             // кто последний редактировал (User.id)
  updatedAt: number;
}

// Фактическая навеска компонента в замесе
export interface MixBatchWeighing {
  componentId: string;
  plannedG: number;              // расчётная граммовка, г
  actualG: number;               // фактическая навеска, г
}

// Журнал замеса — результат выполнения (slave → master пакетами)
export interface MixBatch {
  id: string;
  recipeId?: string;             // по какому стандартному замесу делали (если по базе)
  recipeName: string;            // снимок названия на момент замеса
  taskId?: string;               // задание, в рамках которого выполнен замес
  batchKg: number;               // масса замеса (СВ), кг
  weighings: MixBatchWeighing[]; // фактические навески
  modeActual?: MixModeStage[];   // факт режима (если отличался)
  viscosity?: number;            // вязкость (сП или мПа·с — как принято на участке)
  fineness?: number;             // степень перетира, мкм (лаборатория Хегмана)
  pasteCalc?: {                  // расчётные свойства пасты на момент замеса (модели реологии)
    solidsPctMass: number;       // содержание СВ по массе, %
    solidsPctVol: number;        // содержание СВ по объёму (φ), %
    pasteDensity: number;        // расчётная плотность пасты, г/см³
    etaModel: string;            // модель вязкости (maronpearson и т.п.)
    etaPredictedCp: number;      // предсказанная вязкость, мПа·с (сП)
  };
  notes?: string;                // примечания / дефекты
  workerId: string;              // кто выполнил
  createdAt: number;
  updatedAt: number;             // для синхронизации
}

// ============================================================
// КОМНАТА НАНЕСЕНИЯ ПОКРЫТИЯ (coating): данные замеса → намазка,
// журнал нанесения с подстроечными параметрами.
// ============================================================

// Снимок данных замеса, передаваемых на участок нанесения (офлайн-пакетом).
// Нужны для расчёта зазора фильера–фольга и скорости шнекового насоса.
export interface CoatingMixSnapshot {
  mixBatchId: string;            // запись журнала замеса
  recipeName: string;            // название замеса (снимок)
  viscosity?: number;            // вязкость пасты, мПа·с (сП)
  fineness?: number;             // степень перетира, мкм
  solidsPctMass?: number;        // содержание СВ по массе, %
  solidsPctVol?: number;         // содержание СВ по объёму (φ), %
  pasteDensity?: number;         // плотность пасты, г/см³
  batchKg?: number;              // масса замеса, кг
  createdAt: number;             // когда сформирован снимок
}

// Режим нанесения
export type CoatMode = 'continuous' | 'intermittent';

// Запись журнала нанесения покрытия
export interface CoatRun {
  id: string;
  taskId?: string;                 // задание (если работа по заданию)
  mixBatchId?: string;             // замес, из которого взята паста
  mixSnapshot?: CoatingMixSnapshot;// снимок данных замеса (пришёл пакетом или выбран вручную)
  foilType: string;                // фольга (Al / Cu) + толщина, напр. «Al 12 мкм»
  targetDryMgm2?: number;          // целевая поверхностная плотность сухого покрытия, мг/см²
  // Подстроечные параметры линии
  screwRpm?: number;               // скорость шнекового насоса, об/мин
  webSpeedMpm?: number;            // скорость движения фольги, м/мин
  ovenTempsC: number[];            // температуры в шести печах, °C (индексы 0..5)
  // Режим нанесения
  mode: CoatMode;                  // сплошное / с промежутками
  gapWidthMm?: number;             // размер промежутка (полосы без покрытия), мм
  gapPitchMm?: number;             // расстояние между промежутками (шаг), мм
  // Длины
  segLengthsM: number[];           // длина участков нанесения, м (можно добавлять/удалять)
  sideALengthM?: number;           // общая длина нанесённого покрытия, сторона A (м) — считается из segLengthsM
  sideBLengthM?: number;           // общая длина, сторона B (м) — второй проход (двусторонняя намазка)
  wetThicknessUm?: number;         // мокрая толщина (зазор фильеры), мкм
  headGapUm?: number;              // расчётный/фактический зазор фильера–фольга, мкм
  defects?: string;                // дефекты / замечания
  notes?: string;
  workerId: string;
  createdAt: number;
  updatedAt: number;               // для синхронизации slave → master
}

// Комментарий в комнате этапа (общая секция для всех ролей комнаты)
export interface StageComment {
  id: string;
  stage: StageId;
  authorId: string;
  text: string;
  journalEntryId?: string;  // опциональная привязка к записи журнала
  createdAt: Date;
}

// ============================================================
// ОФЛАЙН-ПАКЕТ ПЕРЕДАЧИ (Bluetooth / QR / текст — единый формат)
// ============================================================
