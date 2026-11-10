import type { ServerConnection } from '../sync/serverConnection';

// Planning is explicitly online-only while M2 synchronization is not
// implemented. Access tokens are read from the volatile verified server
// session, never from the local demo user's persisted auth token.
export type PlanningSession = Pick<ServerConnection, 'session'>;
export type MaterialLine = 'cathode' | 'anode' | 'cell';
export type QuantityUnit = 'cells' | 'pieces' | 'kg' | 'm' | 'm2';
export type BatchStatus = 'created' | 'in_progress' | 'hold' | 'completed' | 'scrapped';
export type RouteState = 'draft' | 'approved';
export type RouteStep = {
  name: string;
  stage: string;
  workshopId: string;
  electrodeLine: 'cathode' | 'anode' | 'common';
};
export type Workshop = { id: string; name: string };
export type Route = { id: string; code: string; name: string; version: number; state: RouteState; stepCount: number };
export type ProductionOrder = {
  id: string; orderCode: string; productCode: string; routeId: string;
  routeVersion: number; status: string; plannedQuantity: string; quantityUnit: QuantityUnit;
};
export type Batch = {
  id: string; batchCode: string; materialLine: MaterialLine;
  status: BatchStatus; plannedQuantity: string; quantityUnit: QuantityUnit;
};
export type BatchEvent = {
  number: number; fromStatus: BatchStatus | null; toStatus: BatchStatus;
  actorId: string; reason: string | null; occurredAt: string;
};
export type StepDetail = RouteStep & { number: number };

function endpoint(origin: string, path: string): string {
  const url = new URL(origin);
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Для планирования требуется HTTPS (кроме localhost)');
  }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Неверный адрес сервера: требуется только HTTPS-адрес без пути');
  }
  if (!path.startsWith('/planning/') || path.startsWith('//')) throw new Error('Invalid planning path');
  return new URL(path, url).toString();
}

export async function planningRequest<T>(
  connection: PlanningSession,
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT'; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  // Validate the destination before attaching the bearer token.
  const url = endpoint(connection.session.serverUrl, path);
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: 'Bearer ' + connection.session.accessToken,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal,
    cache: 'no-store',
  });
  if (!response.ok) {
    const failure: unknown = await response.json().catch(() => null);
    const code = typeof failure === 'object' && failure !== null && 'error' in failure &&
      typeof failure.error === 'string' ? failure.error : 'server_request_failed';
    throw new Error('HTTP ' + response.status + ': ' + code);
  }
  return response.json() as Promise<T>;
}

const id = (value: string) => encodeURIComponent(value);
export const planningApi = {
  workshops: (c: PlanningSession, signal?: AbortSignal) =>
    planningRequest<{ workshops: Workshop[] }>(c, '/planning/workshops', { signal }),
  createWorkshop: (c: PlanningSession, input: Workshop) =>
    planningRequest<Workshop>(c, '/planning/workshops', { method: 'POST', body: input }),
  routes: (c: PlanningSession, signal?: AbortSignal) =>
    planningRequest<{ routes: Route[] }>(c, '/planning/routes', { signal }),
  createRoute: (c: PlanningSession, input: { code: string; name: string; steps: RouteStep[] }) =>
    planningRequest<{ id: string; version: number }>(c, '/planning/routes', { method: 'POST', body: input }),
  routeSteps: (c: PlanningSession, routeId: string, version: number) =>
    planningRequest<{ id: string; version: number; state: RouteState; steps: StepDetail[] }>(
      c, '/planning/routes/' + id(routeId) + '/versions/' + version + '/steps'),
  forkRoute: (c: PlanningSession, routeId: string) =>
    planningRequest<{ id: string; version: number }>(c, '/planning/routes/' + id(routeId) + '/versions', { method: 'POST' }),
  replaceRouteSteps: (c: PlanningSession, routeId: string, version: number, steps: RouteStep[]) =>
    planningRequest<{ id: string; version: number }>(
      c, '/planning/routes/' + id(routeId) + '/versions/' + version + '/steps',
      { method: 'PUT', body: { steps } }),
  approveRoute: (c: PlanningSession, routeId: string, version: number) =>
    planningRequest<{ id: string; version: number }>(
      c, '/planning/routes/' + id(routeId) + '/versions/' + version + '/approve',
      { method: 'POST' }),
  orders: (c: PlanningSession, signal?: AbortSignal) =>
    planningRequest<{ orders: ProductionOrder[] }>(c, '/planning/orders', { signal }),
  createOrder: (c: PlanningSession, input: {
    orderCode: string; productCode: string; routeId: string; routeVersion: number;
    plannedQuantity: string; quantityUnit: QuantityUnit;
  }) => planningRequest<ProductionOrder>(c, '/planning/orders', { method: 'POST', body: input }),
  releaseOrder: (c: PlanningSession, orderId: string) =>
    planningRequest<{ id: string; status: string }>(
      c, '/planning/orders/' + id(orderId) + '/release', { method: 'POST' }),
  batches: (c: PlanningSession, orderId: string, signal?: AbortSignal) =>
    planningRequest<{ orderId: string; batches: Batch[] }>(
      c, '/planning/orders/' + id(orderId) + '/batches', { signal }),
  createBatch: (c: PlanningSession, orderId: string, input: {
    batchCode: string; materialLine: MaterialLine;
    plannedQuantity: string; quantityUnit: QuantityUnit;
  }) => planningRequest<Batch>(
    c, '/planning/orders/' + id(orderId) + '/batches', { method: 'POST', body: input }),
  changeBatchStatus: (c: PlanningSession, batchId: string, input: {
    expectedStatus: BatchStatus; status: BatchStatus; reason?: string;
  }) => planningRequest<{ id: string; status: BatchStatus }>(
    c, '/planning/batches/' + id(batchId) + '/status', { method: 'POST', body: input }),
  batchEvents: (c: PlanningSession, batchId: string, signal?: AbortSignal) =>
    planningRequest<{ id: string; status: BatchStatus; events: BatchEvent[] }>(
      c, '/planning/batches/' + id(batchId) + '/events', { signal }),
};
