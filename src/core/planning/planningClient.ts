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
export type HandoffInboxItem = {
  id: string; batchId: string; batchCode: string;
  fromStep: number; toStep: number;
  fromWorkshopId: string; toWorkshopId: string;
  quantity: string; quantityUnit: QuantityUnit;
  sentBy: string; sentAt: string; note: string | null;
};
export type BatchHandoff = Omit<HandoffInboxItem, 'batchId' | 'batchCode'> & {
  receivedBy: string | null; receivedAt: string | null; receiptNote: string | null;
};
export type GenealogyKind = 'assembly' | 'split' | 'merge' | 'consumption';
export type BatchGenealogyLink = {
  id: string; sourceBatchId: string; targetBatchId: string;
  sourceCode: string; targetCode: string; kind: GenealogyKind;
  sourceQuantity: string; sourceUnit: QuantityUnit;
  targetQuantity: string; targetUnit: QuantityUnit;
  actorId: string; note: string | null; occurredAt: string;
};
export type BatchGenealogyPage = {
  batchId: string; links: BatchGenealogyLink[];
  hasMore: boolean; nextAfter: string | null;
};
export type StepEvidenceKind = 'started' | 'completed' | 'deviation';
export type StepEvidence = {
  id: string; kind: StepEvidenceKind; actorId: string;
  quantity: string | null; quantityUnit: QuantityUnit | null;
  equipmentCode: string | null; note: string | null; recordedAt: string;
};
export type BatchStepRecord = {
  number: number; name: string; stage: string; workshopId: string;
  evidence: StepEvidence | null;
};
export type StepDetail = RouteStep & { number: number };
export type LocalSourceKind =
  'journal' | 'mix_batch' | 'coat_run' | 'calender_run' | 'cut_run' |
  'sort_run' | 'assembly_run';
export type LocalSourceMeasure = {
  kind: 'dry_solids_kg' | 'coated_side_a_m' |
    'calendered_length_m' | 'cut_good_pieces' |
    'sort_input_good_pieces' | 'assembled_cells_out'; value: string;
};
export type LocalJournalLink = {
  id: string; stepNumber: number; sourceStage: string; sourceEntryId: string;
  sourceKind: LocalSourceKind; sourceMeasure: LocalSourceMeasure | null;
  sourceCreatedAt: string; summary: string; defects: string | null;
  linkedBy: string; linkedAt: string;
};
export type InspectionKind = 'measurement' | 'visual';
export type InspectionUnit = 'um' | 'mm' | 'g' | 'mg' | 'mOhm' |
  'V' | 'mAh' | 'pct' | 'C';
export type InspectionCriterion = {
  id: string; stepNumber: number; characteristic: string;
  unit: InspectionUnit; lowerLimit: string | null; upperLimit: string | null;
  note: string | null; createdBy: string; createdAt: string;
};
export type InspectionCriterionInput = {
  criterionId: string; characteristic: string; unit: InspectionUnit;
  lowerLimit?: string; upperLimit?: string; note?: string;
};
export type InspectionReviewOutcome = 'follow_up_required' | 'reviewed_no_block';
export type InspectionReview = {
  number: number; outcome: InspectionReviewOutcome; reason: string;
  reviewedBy: string; reviewedAt: string;
};
export type InspectionObservation = {
  id: string; stepNumber: number; kind: InspectionKind;
  characteristic: string; observedValue: string | null;
  observedUnit: InspectionUnit | null; attentionRequired: boolean;
  note: string | null; recordedBy: string; recordedAt: string;
  latestReview?: InspectionReview | null;
  reviewHistory?: InspectionReview[];
  referenceComparison?: 'no_reference' | 'below_reference' |
    'above_reference' | 'within_reference';
  referenceCriterionId?: string | null;
  referenceLowerLimit?: string | null;
  referenceUpperLimit?: string | null;
};
export type InspectionInput =
  | { observationId: string; kind: 'measurement'; characteristic: string;
      observedValue: string; observedUnit: InspectionUnit;
      attentionRequired: boolean; note?: string }
  | { observationId: string; kind: 'visual'; characteristic: string;
      attentionRequired: boolean; note: string };
export type QuantityFlowStep = {
  number: number; name: string; workshopId: string; nextStep: number | null;
  output: { quantity: string; unit: QuantityUnit } | null;
  handoff: { id: string; quantity: string; unit: QuantityUnit; received: boolean } | null;
  difference: string | null;
};

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
    // Never follow a redirect carrying a planning session's bearer token.
    // Redirects to login/other hosts must be surfaced as an error instead.
    redirect: 'error',
    credentials: 'omit',
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
  handoffInbox: (c: PlanningSession, signal?: AbortSignal) =>
    planningRequest<{ handoffs: HandoffInboxItem[] }>(c, '/planning/handoffs/inbox', { signal }),
  batchHandoffs: (c: PlanningSession, batchId: string, signal?: AbortSignal) =>
    planningRequest<{ batchId: string; handoffs: BatchHandoff[] }>(
      c, '/planning/batches/' + id(batchId) + '/handoffs', { signal }),
  sendHandoff: (c: PlanningSession, batchId: string, input: {
    handoffId: string; fromStep: number; toStep: number;
    quantity: string; quantityUnit: QuantityUnit; note?: string;
  }) => planningRequest<{ id: string; status: 'sent' | 'already_sent' }>(
    c, '/planning/batches/' + id(batchId) + '/handoffs', { method: 'POST', body: input }),
  receiveHandoff: (c: PlanningSession, handoffId: string, note?: string) =>
    planningRequest<{ id: string; status: 'received' }>(
      c, '/planning/handoffs/' + id(handoffId) + '/receive',
      { method: 'POST', body: note?.trim() ? { note: note.trim() } : {} }),
  batchGenealogy: async (c: PlanningSession, batchId: string, signal?: AbortSignal, after?: string) => {
    const page = await planningRequest<BatchGenealogyPage>(
      c, '/planning/batches/' + id(batchId) + '/links' +
        (after ? '?after=' + id(after) : ''), { signal });
    const quantity = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;
    const units = ['cells','pieces','kg','m','m2'];
    if (!page || page.batchId !== batchId || !Array.isArray(page.links) ||
        page.links.length > 500 || typeof page.hasMore !== 'boolean' ||
        (page.hasMore ? !page.links.length || page.nextAfter !== page.links[page.links.length-1]?.id ||
          page.nextAfter === after : page.nextAfter !== null) ||
        new Set(page.links.map(link => link?.id)).size !== page.links.length ||
        page.links.some(link => !link ||
          !['id','sourceBatchId','targetBatchId','sourceCode','targetCode','actorId']
            .every(key => typeof link[key as keyof BatchGenealogyLink] === 'string' &&
              Boolean(link[key as keyof BatchGenealogyLink])) ||
          link.id === after || link.sourceBatchId === link.targetBatchId ||
          (link.sourceBatchId !== batchId && link.targetBatchId !== batchId) ||
          !['assembly','split','merge','consumption'].includes(link.kind) ||
          !units.includes(link.sourceUnit) || !units.includes(link.targetUnit) ||
          typeof link.sourceQuantity !== 'string' || !quantity.test(link.sourceQuantity) ||
          typeof link.targetQuantity !== 'string' || !quantity.test(link.targetQuantity) ||
          typeof link.occurredAt !== 'string' || !Number.isFinite(Date.parse(link.occurredAt)) ||
          (link.note !== null && typeof link.note !== 'string'))) {
      throw new Error('Сервер вернул неверную историю партий; обновите сервер и повторите запрос');
    }
    return page;
  },
  declareGenealogy: (c: PlanningSession, targetBatchId: string, input: {
    declarationId?: string; // stable UUID makes uncertain network retries safe
    sourceBatchId: string; kind: GenealogyKind;
    sourceQuantity: string; sourceUnit: QuantityUnit;
    targetQuantity: string; targetUnit: QuantityUnit; note?: string;
  }) => planningRequest<{ id: string; sourceBatchId: string; targetBatchId: string; kind: GenealogyKind }>(
    c, '/planning/batches/' + id(targetBatchId) + '/links', { method: 'POST', body: input }),
  stepEvidence: (c: PlanningSession, batchId: string, signal?: AbortSignal) =>
    planningRequest<{ batchId: string; steps: BatchStepRecord[] }>(
      c, '/planning/batches/' + id(batchId) + '/steps', { signal }),
  journalLinks: (c: PlanningSession, batchId: string, signal?: AbortSignal) =>
    planningRequest<{ batchId: string; links: LocalJournalLink[] }>(
      c, '/planning/batches/' + id(batchId) + '/journal-links', { signal }),
  attachLocalJournal: (c: PlanningSession, batchId: string, stepNumber: number, input: {
    linkId: string; sourceEntryId: string; sourceStage: string;
    sourceKind?: LocalSourceKind; sourceMeasure?: LocalSourceMeasure;
    sourceCreatedAt: string; summary: string; defects?: string;
  }) => planningRequest<{ id: string; alreadyLinked: boolean }>(
    c, '/planning/batches/' + id(batchId) + '/steps/' + stepNumber + '/journal-links',
    { method: 'POST', body: input }),
  routeInspectionCriteria: (c: PlanningSession, routeId: string,
    version: number, signal?: AbortSignal) =>
    planningRequest<{ routeId: string; version: number; state: RouteState;
      frozen: boolean; criteria: InspectionCriterion[] }>(
      c, '/planning/routes/' + id(routeId) + '/versions/' + version +
        '/inspection-criteria', { signal }),
  addInspectionCriterion: (c: PlanningSession, routeId: string, version: number,
    stepNumber: number, input: InspectionCriterionInput) =>
    planningRequest<{ id: string; alreadyRecorded: boolean }>(
      c, '/planning/routes/' + id(routeId) + '/versions/' + version +
        '/steps/' + stepNumber + '/inspection-criteria',
      { method: 'POST', body: input }),
  batchInspectionCriteria: (c: PlanningSession, batchId: string,
    signal?: AbortSignal) =>
    planningRequest<{ batchId: string; criteria: InspectionCriterion[] }>(
      c, '/planning/batches/' + id(batchId) + '/inspection-criteria', { signal }),
  inspections: (c: PlanningSession, batchId: string, signal?: AbortSignal) =>
    planningRequest<{ batchId: string; observations: InspectionObservation[] }>(
      c, '/planning/batches/' + id(batchId) + '/inspections', { signal }),
  recordInspection: (c: PlanningSession, batchId: string, stepNumber: number,
      input: InspectionInput) =>
    planningRequest<{ id: string; batchId: string; stepNumber: number;
      alreadyRecorded: boolean }>(
      c, '/planning/batches/' + id(batchId) + '/steps/' + stepNumber + '/inspections',
      { method: 'POST', body: input }),
  reviewInspection: (c: PlanningSession,batchId:string,observationId:string,
    input:{reviewId:string;outcome:InspectionReviewOutcome;reason:string}) =>
    planningRequest<{id:string;reviewNumber:number;alreadyRecorded:boolean}>(
      c, '/planning/batches/'+id(batchId)+'/inspections/'+id(observationId)+'/reviews',
      {method:'POST',body:input}),
  quantityFlow: (c: PlanningSession, batchId: string, signal?: AbortSignal) =>
    planningRequest<{ batchId: string; steps: QuantityFlowStep[] }>(
      c, '/planning/batches/' + id(batchId) + '/quantity-flow', { signal }),
  recordStepEvidence: (c: PlanningSession, batchId: string, stepNumber: number, input: {
    eventId: string; kind: StepEvidenceKind;
    quantity?: string; quantityUnit?: QuantityUnit;
    equipmentCode?: string; note?: string;
  }) => planningRequest<{ id: string; stepNumber: number;
    kind: StepEvidenceKind; alreadyRecorded: boolean }>(
      c, '/planning/batches/' + id(batchId) + '/steps/' + stepNumber + '/evidence',
      { method: 'POST', body: input }),
};
