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
  SORTING = 'sorting',         // Сортировка / рубка пластин
  ASSEMBLY = 'assembly',       // Сборка элементов
  ELECTROLYTE = 'electrolyte', // Розлив электролита
  FORMATION = 'formation',     // Формирование (ЧЦЦ)
  AGING = 'aging',             // Старение
}

export const STAGE_LABELS: Record<StageId, string> = {
  [StageId.STORAGE]: 'Склад материалов',
  [StageId.SLURRY]: 'Комната замесов',
  [StageId.COATING]: 'Нанесение покрытия',
  [StageId.CALENDARING]: 'Каландрирование',
  [StageId.SORTING]: 'Сортировка',
  [StageId.ASSEMBLY]: 'Сборка элементов',
  [StageId.ELECTROLYTE]: 'Розлив электролита',
  [StageId.FORMATION]: 'Формирование (ЧЦЦ)',
  [StageId.AGING]: 'Старение',
};

// Порядок техпроцесса (для навигации и KPI-цепочки)
export const STAGE_ORDER: StageId[] = [
  StageId.STORAGE, StageId.SLURRY, StageId.COATING, StageId.CALENDARING,
  StageId.SORTING, StageId.ASSEMBLY, StageId.ELECTROLYTE,
  StageId.FORMATION, StageId.AGING,
];

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
  | 'chat'            // сообщение меш-чата (работник ↔ мастер ↔ технолог ↔ начальник)
  | 'forced-push';  // принудительная запись master'ом в slave-устройство

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
