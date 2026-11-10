import type { ServerConnection } from './serverConnection';

/** Production planning is online-only. Never queue these writes in Dexie or
 * reuse the unauthenticated local demo login as a server identity. */
export interface PlanningWorkshop { id: string; name: string }
export interface RouteStepInput {
  name: string;
  stage: string;
  workshopId: string;
  electrodeLine: 'cathode' | 'anode' | 'common';
}
export interface PlanningRoute {
  id: string; code: string; name: string; version: number;
  state: 'draft' | 'approved'; stepCount: number;
}
export interface PlanningOrder {
  id: string; orderCode: string; productCode: string;
  routeId: string; routeVersion: number; status: string;
  plannedQuantity: string; quantityUnit: string;
}
export interface PlanningBatch {
  id: string; batchCode: string; materialLine: 'cathode'|'anode'|'cell';
  status: 'created'|'in_progress'|'hold'|'completed'|'scrapped';
  plannedQuantity: string; quantityUnit: string;
}
export interface BatchEvent {
  number: number; fromStatus: string | null; toStatus: string;
  actorId: string; reason: string | null; occurredAt: string;
}

const serverErrors: Record<string, string> = {
  route_code_exists: 'Маршрут с таким кодом уже существует.',
  workshop_already_exists: 'Участок с таким кодом уже существует.',
  unknown_route_workshop: 'Участок не существует на сервере.',
  route_not_approved: 'Для заказа нужен утверждённый маршрут.',
  route_not_draft_or_empty: 'Утвердить можно только непустой черновик.',
  latest_route_version_not_approved: 'Сначала утвердите последний черновик маршрута.',
  approved_route_is_immutable: 'Утверждённый маршрут нельзя изменить. Создайте новую версию.',
  order_code_exists: 'Код заказа уже существует.',
  order_not_releasable: 'Заказ не может быть запущен повторно.',
  order_not_released: 'Сначала выпустите заказ.',
  batch_code_exists: 'Код партии уже существует.',
  batch_status_changed: 'Статус партии изменился на сервере. Обновите список.',
  invalid_batch_status_transition: 'Недопустимый переход статуса партии.',
  reason_required: 'Для блокировки или списания требуется причина.',
  unauthorized: 'Серверная сессия истекла. Подключитесь снова.',
  forbidden: 'У серверной учётной записи нет прав на это действие.',
};

export function planningEndpoint(origin: string, path: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    throw new Error('Для планирования нужен HTTPS');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !path.startsWith('/planning/') || path.startsWith('//')) {
    throw new Error('Некорректный адрес сервера планирования');
  }
  return new URL(path, url).toString();
}

export async function planningRequest<T>(
  connection: ServerConnection,
  path: string,
  options: { method?: 'GET'|'POST'|'PUT'; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  if (!['chief', 'technologist', 'master'].includes(connection.serverRole) ||
      !connection.session.accessToken) {
    throw new Error('Подключитесь под серверной учётной записью с правами планирования');
  }
  const response = await fetch(planningEndpoint(connection.session.serverUrl, path), {
    method: options.method ?? 'GET',
    headers: {
      Authorization: 'Bearer ' + connection.session.accessToken,
      'Content-Type': 'application/json',
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
  });
  if (!response.ok) {
    const errorBody: unknown = await response.json().catch(() => null);
    const key = errorBody && typeof errorBody === 'object' && 'error' in errorBody &&
      typeof errorBody.error === 'string' ? errorBody.error : '';
    throw new Error(serverErrors[key] ?? ('Ошибка сервера: HTTP ' + response.status));
  }
  return response.json() as Promise<T>;
}
