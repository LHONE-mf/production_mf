// ============================================================
import { StageId } from '../index';
import type { CellType } from './assembly';
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

export type ElectrolyteBox = 'dry-room' | 'floor7-room5';

/** Входящая партия ячеек со сборки в один из боксов заливки */
export interface ElectrolyteIncoming {
  id: string;
  box: ElectrolyteBox;               // куда пришла партия (помещение)
  batchName: string;
  serialRange?: SerialRange;            // номера аккумуляторов партии (миграция со сборки)
  cellType?: CellType;               // тип ячейки (цилиндрическая/призматическая)
  cellsIn: number;                   // сколько ячеек принято
  fromAssemblyRunId?: string;        // связь с AssemblyRun
  receivedAt: string;
  updatedAt: string;
}

/** Запись журнала заливки электролита (одна операция/партия в боксе) */
export interface FillRun {
  id: string;
  box: ElectrolyteBox;               // помещение заливки
  batchName: string;                 // партия (из входящей или вручную)
  serialRange?: SerialRange;         // номера аккумуляторов (мигрируют со сборки → далее на формовку)
  electrolyteName?: string;          // марка/название электролита
  doseMin?: number;                  // дозировка целевая, мг (задаёт технолог)
  doseActual?: number;               // фактическая дозировка, мг
  vacuumKpa?: number;                // глубина вакуума при пропитке, кПа
  pressureKpa?: number;              // давление впрыска, кПа
  dwellMin?: number;                 // выдержка (время пропитки), мин
  temperatureC?: number;             // температура в боксе / электролита, °C
  humidityPpm?: number;              // точка росы / влажность бокса, °C т.р. или ppm
  cellsFilled: number;               // залито ячеек (годных)
  cellsScrap: number;                // брак (недолив/перелив/пузыри/подтекание)
  defects: string[];                 // дефекты по реестру
  comment?: string;
  taskId?: string;
  workerId: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// ВАЛЬЦОВКА (обжим/вальцевание залитых цилиндрических ячеек).
// Расположена ПОСЛЕ заливки на 7 этаже (к.5): туда приходят залитые
// ячейки, обжимаются на вальцовочном станке и далее идут на формирование.
// Параметры станка уточним позже — структура расширяемая.
// ============================================================

/** Входящая партия залитых ячеек на вальцовку (из бокса 7 эт./к.5) */
export interface WalzingIncoming {
  id: string;                        // = fillRunId
  batchName: string;
  serialRange?: SerialRange;            // номера аккумуляторов партии (миграция со сборки)
  cellType?: CellType;               // тип ячейки
  cellsIn: number;                   // сколько ячеек принято под вальцовку
  electrolyteName?: string;          // марка электролита (из заливки)
  fromFillRunId?: string;            // связь с FillRun
  receivedAt: string;
  updatedAt: string;
}

/** Запись журнала вальцовки (одна операция/партия на станке) */
export interface WalzRun {
  id: string;
  batchName: string;                 // партия (из входящей или вручную)
  machineNo?: string;                // номер вальцовочного станка
  incomingDiameter?: number;         // диаметр ячейки до вальцовки, мм
  finalDiameter?: number;            // целевой/итоговый диаметр после вальцовки, мм
  passes?: number;                   // количество проходов (валков)
  serialRange?: SerialRange;         // номера аккумуляторов партии (миграция: сборка → заливка → формовка)
  pressureKgf?: number;              // усилие обжима, кгс
  speedRpm?: number;                 // скорость вращения/подачи, об/мин
  temperatureC?: number;             // температура ячейки/окружения, °C
  cellsIn: number;                   // подано ячеек
  cellsOut: number;                  // годных после вальцовки
  cellsScrap: number;                // брак (разрыв,мятость,недобор диаметра)
  defects: string[];                 // дефекты по реестру
  comment?: string;
  taskId?: string;
  workerId: string;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// НОМЕР АККУМУЛЯТОРА (серийный диапазон партии).
// Вводится на сборке, мигрирует дальше по цепочке:
// сборка → заливка (сухая комната / 7 эт.) → вальцовка → формирование.
// Формат: префикс + номера от start до end включительно.
// ============================================================
export interface SerialRange {
  prefix?: string;                   // префикс номера (например "MF-" или пустой)
  start: number;                     // первый номер партии
  end: number;                       // последний номер партии
}

/** Развернуть диапазон в список строк-номеров ("MF-1001"...); максимум limit шт. */
export function serialList(sr: SerialRange | undefined, limit = 500): string[] {
  if (!sr || !Number.isFinite(sr.start) || !Number.isFinite(sr.end)) return [];
  const p = sr.prefix ?? '';
  const out: string[] = [];
  for (let n = sr.start; n <= sr.end && out.length < limit; n++) out.push(`${p}${n}`);
  return out;
}

/** Человекочитаемое описание диапазона: "MF-1001…MF-1200 (200 шт.)" */
export function serialRangeLabel(sr: SerialRange | undefined): string {
  if (!sr || !Number.isFinite(sr.start) || !Number.isFinite(sr.end) || sr.end < sr.start) return '—';
  const p = sr.prefix ?? '';
  const count = sr.end - sr.start + 1;
  return `${p}${sr.start}…${p}${sr.end} (${count} шт.)`;
}

// ============================================================
// ФОРМИРОВАНИЕ (ЧЦЦ — формовка залитых/вальцованных ячеек).
// Связана с ЗАЛИВКОЙ В СУХОЙ КОМНАТЕ: туда приходят номера аккумуляторов,
// которые затем идут на формировку (миграция: сборка → заливка → формовка).
// Также принимает результат вальцовки (после заливки на 7 этаже).
// ============================================================

/** Режим формировки: задание тока/напряжения/числа циклов */
export interface FormationMode {
  currentA?: number;                 // ток заряда/разряда, А
  voltageV?: number;                 // напряжение (отсечка), В
  cycles: number;                    // количество циклов
  note?: string;                     // примечание к режиму (технолог)
}

/** Входящая партия на формировку (из сухой комнаты / вальцовки / вручную) */
export interface FormationIncoming {
  id: string;                        // = fillRunId (заливка в сухой комнате) или walzRunId
  sourceBox: ElectrolyteBox | 'walzing'; // откуда пришла партия
  batchName: string;                 // название партии
  serialRange?: SerialRange;         // номера аккумуляторов (мигрируют со сборки/заливки)
  cellType?: CellType;
  cellsIn: number;
  fromFillRunId?: string;
  fromWalzRunId?: string;
  receivedAt: string;
  updatedAt: string;
}

/** Запись журнала формировки одной партии */
export interface FormationRun {
  id: string;
  batchName: string;
  serialRange?: SerialRange;         // номера аккумуляторов (приходят из входящей партии)
  mode: FormationMode;               // выбранный режим формировки (ток/напряжение/циклы)
  startDate: string;                 // дата начала формировки (ISO yyyy-mm-dd)
  endDate?: string;                  // дата окончания (необязательно)
  coulombEfficiencyPct?: number;     // кулоновская эффективность, %
  capacityCycle5Ah?: number;         // ёмкость пятого цикла формировки, А·ч
  cellsIn: number;                   // подано ячеек
  cellsOut: number;                  // годных после формировки
  cellsScrap: number;                // брак (вздутие, потеря контакта, недобор ёмкости)
  defects: string[];
  comment?: string;
  taskId?: string;
  workerId: string;
  createdAt: string;
  updatedAt: string;
}

// Запись в журнале работ конкретной комнаты (единица учёта для KPI)
