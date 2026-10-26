// ============================================================
// ЭТАПЫ ПРОИЗВОДСТВА («комнаты» цеха). Каждый этап — отдельный
// модуль в src/stages/<id>. Полный офлайн: данные хранятся
// локально, передача только через Bluetooth / QR / текст.
// ============================================================
export enum StageId {
  STORAGE = 'storage',         // Склад материалов
  SLURRY = 'slurry',           // Комната замесов (приготовление шлама)
  COATING = 'coating',         // Нанесение покрытия
  CALENDARING = 'calendaring', // Каландрирование
  CUTTING = 'cutting',         // Нарезка электродов (рулон → пластины/полосы)
  SORTING = 'sorting',         // Сортировка электродов по параметрам КД
  ASSEMBLY = 'assembly',       // Сборка элементов
  ELECTROLYTE = 'electrolyte', // Заливка электролита: бокс сухой комнаты
  ELECTROLYTE_705 = 'electrolyte-705', // Заливка электролита: бокс 7 этаж, к.5
  FORMATION = 'formation',     // Формирование (ЧЦЦ)
  AGING = 'aging',             // Старение
}

export const STAGE_LABELS: Record<StageId, string> = {
  [StageId.STORAGE]: 'Склад материалов',
  [StageId.SLURRY]: 'Комната замесов',
  [StageId.COATING]: 'Нанесение покрытия',
  [StageId.CALENDARING]: 'Каландрирование',
  [StageId.CUTTING]: 'Нарезка электродов',
  [StageId.SORTING]: 'Сортировка',
  [StageId.ASSEMBLY]: 'Сборка элементов',
  [StageId.ELECTROLYTE]: 'Заливка электролита (сухая комната)',
  [StageId.ELECTROLYTE_705]: 'Заливка электролита (7 эт. / к.5)',
  [StageId.FORMATION]: 'Формирование (ЧЦЦ)',
  [StageId.AGING]: 'Старение',
};

// Порядок техпроцесса (для навигации и KPI-цепочки)
export const STAGE_ORDER: StageId[] = [
  StageId.STORAGE, StageId.SLURRY, StageId.COATING, StageId.CALENDARING,
  StageId.CUTTING, StageId.SORTING, StageId.ASSEMBLY, StageId.ELECTROLYTE,
  StageId.ELECTROLYTE_705, StageId.FORMATION, StageId.AGING,
];

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
  batchName: string;                 // название партии со сборки
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

// Запись в журнале работ конкретной комнаты (единица учёта для KPI)
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
export type SyncPacketType =
  | 'task'          // новое задание / изменение задания
  | 'result'        // результат выполнения (закрытие задания)
  | 'journal'       // запись журнала комнаты
  | 'comment'       // комментарий
  | 'user'          // пользователь (создаётся только chief)
  | 'mix-batch'     // журнал замеса (результат, отправляется slave → master)
  | 'mix-component' // компонент из базы комнаты замесов
  | 'mix-recipe'    // стандартный замес из базы
  | 'coating-mix'   // данные замеса → участку нанесения (снимок для расчётов)
  | 'coat-run'      // запись журнала нанесения покрытия (slave → master)
  | 'roll-spec'     // рулон намазка → технологу (master) → каландрирование
  | 'calender-result' // результат прокатки → нарезка / master
  | 'cutting-roll'    // рулон + задание технолога: каландр/технолог → нарезка
  | 'cut-run'         // запись журнала нарезки → сортировка / master
  | 'sort-spec'       // спецификация сортировки от технолога (параметры из КД) → сортировка
  | 'sort-run'        // результат сортировки партии → мастер/технолог (master)
  | 'defect-entry'    // запись реестра дефектов электродов (критичные/не критичные)
  | 'assembly-run'    // партия сборки элементов (сортировка → сборка → формовка/master)
  | 'electrolyte-in'  // входящая партия ячеек со сборки в бокс заливки
  | 'fill-run'        // результат заливки электролита (журнал → master/формирование)
  | 'chat'            // сообщение меш-чата (работник ↔ мастер ↔ технолог ↔ начальник)
  | 'forced-push';  // принудительная запись master'ом в slave-устройство

// ============================================================
// КОМНАТА НАРЕЗКИ ЭЛЕКТРОДОВ: рулон с каландра + задание технолога
// (тип электрода, покрытие, длина) → журнал нарезки → сортировка.
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
export interface ChatMessage {
  id: string;            // id = from + ':' + ts (детерминированный — дедупликация в mesh)
  from: string;          // User.id автора
  fromName: string;      // имя автора для отображения (на случай, если пользователя ещё нет в базе)
  role?: UserRole;       // роль автора (для бейджа)
  text: string;
  ts: number;            // миллисекунды
  ttl: number;           // счётчик ретрансляций: стартует с MAX_HOPS, уменьшается при каждой пересылке
}

export const CHAT_MAX_HOPS = 5;   // сколько раз пакет может быть ретранслирован
export const CHAT_TTL_START = CHAT_MAX_HOPS;

export interface SyncPacket {
  v: 1;
  type: SyncPacketType;
  stage?: StageId;
  payload: unknown;         // Task | JournalEntry | StageComment | User ...
  from: string;             // id отправителя (User.id)
  ts: number;               // timestamp миллисекунды
  forced?: boolean;         // пакет от master, применяется безусловно
}

// Роли пользователей в системе
export enum UserRole {
  WORKER = 'worker',           // Работник
  TECHNOLOGIST = 'technologist', // Технолог
  MASTER = 'master',           // Мастер цеха
  CHIEF = 'chief',             // Начальник производства
}

// Права доступа для каждой роли
export interface RolePermissions {
  canViewOwnTasks: boolean;
  canCreateTasks: boolean;
  canAssignTasks: boolean;
  canManageUsers: boolean;
  canViewAllTasks: boolean;
  canEditTechCards: boolean;
  canViewWorkshopReports: boolean;
  canViewProductionReports: boolean;
  canManageMasterSlave: boolean;
  canConfigureMesh: boolean;
}

// Пользователь
export interface User {
  id: string;
  login: string;
  password: string; // В реальном приложении - хеш
  fullName: string;
  role: UserRole;
  createdAt: Date;
  isActive: boolean;
  assignedMasterId?: string; // ID мастера/начальника (для slave-устройств)
}

// Статус задания
export enum TaskStatus {
  CREATED = 'created',
  ASSIGNED = 'assigned',
  IN_PROGRESS = 'in_progress',
  CHECKED = 'checked',
  COMPLETED = 'completed',
  REJECTED = 'rejected',
}

// Приоритет задания
export enum TaskPriority {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

// Задание
export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedTo: string; // User ID
  createdBy: string; // User ID
  createdAt: Date;
  updatedAt: Date;
  dueDate?: Date;
  techCardId?: string;
  stage?: StageId;      // этап производства (комната), к относится задание
  workshopId?: string;
  comments: TaskComment[];
  attachments: TaskAttachment[];
}

// Комментарий к заданию
export interface TaskComment {
  id: string;
  taskId: string;
  authorId: string;
  text: string;
  createdAt: Date;
}

// Вложение к заданию
export interface TaskAttachment {
  id: string;
  taskId: string;
  fileName: string;
  fileType: string;
  data: string; // Base64 или URL
  createdAt: Date;
}

// Технологическая карта
export interface TechCard {
  id: string;
  name: string;
  description: string;
  steps: TechCardStep[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

// Шаг технологической карты
export interface TechCardStep {
  id: string;
  order: number;
  title: string;
  description: string;
  duration: number; // в минутах
  parameters?: Record<string, string>;
}

// Устройство для синхронизации
export interface SyncDevice {
  id: string;
  name: string;
  bluetoothId?: string;
  role: 'master' | 'slave';
  masterDeviceId?: string;
  lastSyncAt?: Date;
  isConnected: boolean;
  isOnline: boolean;
}

// Запись синхронизации
export interface SyncLog {
  id: string;
  deviceId: string;
  timestamp: Date;
  direction: 'upload' | 'download' | 'bidirectional';
  recordsSynced: number;
  status: 'success' | 'error' | 'partial';
  errorMessage?: string;
}

// Сообщение Bluetooth Mesh
export interface MeshMessage {
  id: string;
  type: 'task_assign' | 'task_update' | 'sync_request' | 'sync_data' | 'status_update';
  senderId: string;
  targetIds: string[]; // пустой = broadcast
  payload: any;
  timestamp: Date;
  ttl: number; // time to live в секундах
}

// Сессия авторизации
export interface AuthSession {
  userId: string;
  login: string;
  role: UserRole;
  token: string;
  expiresAt: Date;
}

// ===================== КОМНАТА СБОРКИ (Шаг Б1) =====================
// Тип ячейки, которую собирают на участке
export type CellType = 'cylindrical' | 'prismatic'; // цилиндрическая / призматическая

// Шесть подсекций участка сборки (каждая — отдельный блок кода, расширяем по плану)
export type AssemblySubstation =
  | 'li-electrodes'   // B-с1: изготовление отрицательных (литиевых) электродов
  | 'z-stacking'      // B-с2: укладка (Z-стэкинг) — будет расширен
  | 'winding'         // B-с3: скрутка цилиндрических блоков электродов (spiral wound)
  | 'crimp-cyl'       // B-с4: зиговка + точечная + ультразвуковая сварка крышки цилиндрических ячеек
  | 'us-prismatic'    // B-с5: ультразвуковая сварка крышки призматических ячеек
  | 'laser-prismatic';// B-с6: лазерная сварка призматических ячеек

export const ASSEMBLY_SUBSTATIONS: { id: AssemblySubstation; name: string; icon: string }[] = [
  { id: 'li-electrodes',   name: 'Литиевые электроды',            icon: '🔘' },
  { id: 'z-stacking',      name: 'Укладка (Z-стэкинг)',           icon: '📚' },
  { id: 'winding',         name: 'Скрутка блоков',                icon: '🌀' },
  { id: 'crimp-cyl',       name: 'Зиговка + точечная + УЗ (цил.)', icon: '🔩' },
  { id: 'us-prismatic',    name: 'УЗ-сварка крышки (призм.)',     icon: '🔊' },
  { id: 'laser-prismatic', name: 'Лазерная сварка (призм.)',      icon: '🔦' },
];

// Одна операция на подсекции сборки (партия деталей проходит через подсекции по очереди)
export interface AssemblyOp {
  substation: AssemblySubstation;
  workerId: string;
  startedAt?: string;        // ISO — время начала (факультативно)
  finishedAt?: string;       // ISO — время окончания
  qtyIn: number;             // сколько деталей/блоков подали на операцию
  qtyOut: number;            // годных после операции
  qtyScrap: number;          // в брак
  params: Record<string, number | string>; // параметры оборудования (мощность УЗ, импульс точечной сварки, скорость лазера и т.п.)
  defects: string[];         // описания дефектов, замеченных на операции
  note?: string;
}

// Партия сборки: пришла с сортировки (название партии), идёт по подсекциям, результат уходит на формовку
export interface AssemblyRun {
  id: string;
  batchName: string;                 // название партии с сортировки (приходит из sort-run)
  cellType: CellType;                // тип ячейки (задаёт технолог)
  electrodeType?: string;            // перенос из задания технолога (полосы / призматические)
  coatingType?: string;              // тип электродного покрытия
  electrodesPerCell?: number;        // сколько электродов в одной ячейке (для расчёта выхода ячеек)
  ops: AssemblyOp[];                 // операции по подсекциям (добавляются по мере прохождения)
  cellsOut: number;                  // итог: собрано ячеек/батареь (годных)
  cellsScrap: number;                // итог: брак ячеек
  defects: string[];                 // сводные дефекты по партии
  comment?: string;
  taskId?: string;
  workerId: string;
  createdAt: string;
  updatedAt: string;
}
