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

export type ElectrodeShape = 'strip' | 'prismatic'; // полосы (цилиндрические) | призматические пластины

// Входящий рулон на нарезку: спецификация рулона + прокатка + задание технолога
export interface CuttingIncoming {
  id: string;                 // = calenderRunId (или rollId, если прокатки нет)
  roll: RollSpec;             // данные рулона с намазки (название замеса, толщины, длины)
  calender?: CalenderRun;     // результат прокатки (зазоры, толщина после, дефекты)
  thicknessAfterUm?: number;  // толщина после прокатки (мкм) — удобная копия для отображения
  electrodeType: ElectrodeShape;      // тип электродов от технолога
  coatingType?: string;               // тип электродного покрытия (анод/катод, материал)
  electrodeLengthMm?: number;         // длина электрода, мм (для цилиндрических полос)
  webWidthMm?: number;                // ширина полотна/рулона, мм (по умолчанию из фольги)
  techNotes?: string;                 // примечание технолога
  createdAt: number;
}

// Запись журнала нарезки (результат оператора) → далее на сортировку
export interface CutRun {
  id: string;
  incomingId: string;          // CuttingIncoming.id
  taskId?: string;
  electrodeType: ElectrodeShape;
  coatingType?: string;
  electrodeLengthMm?: number;  // фактическая длина, мм
  goodCount: number;           // количество нарезанных годных электродов
  defectCount: number;         // количество с дефектами
  defects?: string;            // виды дефектов / обрывы
  breaks?: number;             // число обрывов ленты
  notes?: string;
  workerId: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================================
// КОМНАТА СОРТИРОВКИ ЭЛЕКТРОДОВ: партия с нарезки (cut-run) +
// спецификация технолога (параметры из КД) → разнесение годных
// электродов по категориям → журнал сортировки → master.
// ============================================================

// Категория сортировки (строка спецификации технолога из КД)
// ── Реестр дефектов электродов (сортировка по КД) ────────────────────────────
export type DefectSeverity = 'critical' | 'non-critical';

export interface DefectEntry {
  id: string;
  title: string;              // название дефекта
  severity: DefectSeverity;   // критичный / не критичный
  description?: string;       // как проявляется / откуда берётся
  action?: string;            // требуемое действие (отбраковка / допустимо в пределах нормы)
  createdAt: number;
  updatedAt: number;
}

export interface SortCategory {
  name: string;               // название категории/сорта, напр. «Сорт А»
  criteria: string;           // критерии из КД: толщина, масса, размеры и т.п.
  minUm?: number;             // допуск по толщине: мин., мкм
  maxUm?: number;             // допуск по толщине: макс., мкм
  minMass?: number;           // допуск по массе: мин., г
  maxMass?: number;           // допуск по массе: макс., г
  allowedDefects?: string[];  // id дефектов из реестра, допустимых для этой категории
  notes?: string;             // примечание технолога
}

// Спецификация сортировки от технолога (master) — параметры из КД
export interface SortSpec {
  id: string;                 // = sortRunKey партии или отдельный id
  batchName: string;          // название партии нарезанных электродов (из CutRun/incoming)
  incomingId?: string;        // CuttingIncoming.id
  cutRunId?: string;          // CutRun.id — конкретная партия нарезки
  electrodeType: ElectrodeShape;
  coatingType?: string;       // тип покрытия (анод/катод, материал)
  parameterName: string;      // сортируемый параметр (напр. «толщина электрода», «омич. сопр.»)
  unit: string;               // единица измерения (мкм, мОм·см², мм…)
  categories: SortCategory[]; // категории с допусками из КД
  techNotes?: string;
  authorId: string;           // технолог, выдавший спецификацию
  createdAt: number;
  updatedAt: number;
}

// Одна строка разноса: сколько электродов отнесено в категорию
export interface SortBucket {
  categoryName: string;       // = SortCategory.name
  count: number;              // количество электродов в категории
  avgThicknessUm?: number;    // средняя измеренная толщина, мкм
  avgMassG?: number;          // средняя измеренная масса, г
}

// Результат сортировки партии (запись журнала оператора)
export interface SortRun {
  id: string;
  specId: string;             // SortSpec.id по которой сортировали
  batchName: string;          // название партии (пришла с нарезки)
  goodCount: number;          // сколько годных пришло с нарезки (контрольная сумма входа)
  buckets: SortBucket[];      // разнесено по категориям
  rejected: number;           // не подошли ни под одну категорию / брак при сортировке
  defects?: string;           // замеченные дефекты в ходе сортировки
  notes?: string;
  workerId: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================================
// КОМНАТА КАЛАНДРИРОВАНИЯ: рулон с намазки incoming → технологу,
// параметры прокатки от технолога (master), журнал прокатки.
// ============================================================

// Рулон, передаваемый с участка нанесения технологу (master) для уточнения прокатки
export interface RollSpec {
  id: string;                    // = coatRunId
  mixName: string;               // название замеса
  thicknessBeforeUm?: number;    // толщина покрытия до прокатки (мкм) — из расчётов намазки/журнала
  segLengthsM: number[];         // длины участков нанесения, м
  sideALengthM?: number;         // общая длина, сторона A, м
  sideBLengthM?: number;         // общая длина, сторона B, м
  foilType?: string;             // фольга, напр. «Al 12 мкм»
  createdAt: number;
}

// Пакет «рулон технологу»: содержит спецификацию + параметры прокатки,
// которые технолог (master) может задать/уточнить. Slave применяет их как задание.
export interface RollToTechPacket {
  roll: RollSpec;
  calenderParams?: CalenderParams; // если заданы — сразу applying на каландре
}

// Параметры прокатки, назначаемые технологом (master)
export interface CalenderParams {
  targetThicknessUm?: number;    // целевая толщина после прокатки, мкм
  heating: boolean;              // необходим ли нагрев валков
  heatTempC?: number;            // температура нагрева, °C
  pressureTons?: number;         // давление прокатки, тс
  edgeTrim: boolean;             // обрезка кромок электродов (облегчает прокатку)
  notes?: string;
}

// Журнал прокатки (результат оператора каландра) → далее на нарезку
export interface CalenderRun {
  id: string;
  rollId: string;                // RollSpec.id (связь с рулоном с намазки)
  taskId?: string;
  params?: CalenderParams;       // какие параметры были назначены технологом
  gapsMm: number[];              // получившиеся зазоры валков по проходам, мм
  totalLengthM?: number;         // общая длина прокатанного полотна, м
  thicknessAfterUm?: number;     // фактическая толщина после прокатки, мкм
  hasDefects: boolean;           // наличие дефектов в ходе прокатки
  defects?: string;              // описание дефектов
  notes?: string;
  workerId: string;
  createdAt: number;
  updatedAt: number;
}

// ============================================================
// МЕШ-ЧАТ (офлайн): сообщения распространяются по BLE-mesh,
// QR и тексту тем же механизмом LIP-пакетов.
// ============================================================
