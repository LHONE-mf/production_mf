import {db} from '../db';
import {toInventoryBaseUnits} from './inventoryReceiving';
import type {HybridSession} from './hybridClient';
import {inventoryRequest} from './inventoryClient';
import {loadInventoryIssueContext} from './inventoryIssueClient';
import {issueIdValid as id, issueTextValid as text} from './inventoryIssueTypes';
import {
  inventoryOutbox,
  inventoryScopeKey,
  type InventoryScope,
  type ReceivingDraft,
} from './inventoryOutbox';
import {withInventorySync} from './inventorySyncLock';
import {sameOutput as same} from './inventoryOutputTypes';
import {
  copyCustodyRequest,
  copySlurrySource,
  copyOutputLot,
  copyDeclaration,
  copyHandoff,
  copyReceipt,
  copyRoomHandoff,
  copyMaterial,
  copyRecipient,
  type CustodyCommand,
  type CustodyRequest,
  type CustodyBase,
  type SlurryOutputRequest,
  type RoomHandoffRequest,
  type RoomReceiptRequest,
  type SlurryOutputSource,
  type SlurryOutputLot,
  type RoomHandoffRead,
} from './roomCustodyTypes';
export interface CustodyPage<T> {
  epoch: string;
  postingEnabled: boolean;
  items: T[];
  nextAfter: string | null;
}
async function readPage<T>(
  session: HybridSession,
  scope: InventoryScope,
  path: string,
  copy: (r: unknown) => T,
  itemId: (r: T) => string,
  after?: string,
  params: Record<string, string> = {},
) {
  if (after !== undefined && !id(after)) throw Error('Некорректная страница истории');
  const response = await inventoryRequest(
    session,
    scope,
    path + '?' + new URLSearchParams({deviceId: scope.deviceId, ...params, ...(after ? {after} : {})}),
  );
  if (!response.ok) throw Error('Движение материала недоступно: HTTP ' + response.status);
  const raw = await response.json();
  if (
    raw?.organizationId !== scope.organizationId ||
    raw.actorId !== scope.actorId ||
    raw.deviceId !== scope.deviceId ||
    !id(raw.epoch) ||
    typeof raw.postingEnabled !== 'boolean' ||
    !Array.isArray(raw.items) ||
    raw.items.length > 50 ||
    typeof raw.hasMore !== 'boolean'
  )
    throw Error('Некорректная область движения материала');
  let previous = after ?? '';
  const items: T[] = raw.items.map((v: unknown) => {
    const r = copy(v),
      key = itemId(r);
    if (!id(key) || key <= previous) throw Error('Некорректный порядок страницы');
    previous = key;
    return r;
  });
  if (raw.hasMore ? items.length !== 50 || raw.nextAfter !== previous : raw.nextAfter !== null)
    throw Error('Некорректный указатель истории');
  return {
    raw,
    page: {
      epoch: raw.epoch as string,
      postingEnabled: raw.postingEnabled as boolean,
      items,
      nextAfter: raw.nextAfter as string | null,
    },
  };
}
export async function loadSlurryOutputSources(session: HybridSession, scope: InventoryScope, after?: string) {
  return (
    await readPage(
      session,
      scope,
      '/inventory/room-outputs/slurry/sources',
      copySlurrySource,
      (r) => r.operationId,
      after,
    )
  ).page;
}
export async function loadSlurryOutputs(session: HybridSession, scope: InventoryScope, after?: string) {
  return (await readPage(session, scope, '/inventory/room-outputs/slurry', copyOutputLot, (r) => r.id, after))
    .page;
}
export async function loadCustodyMaterials(
  session: HybridSession,
  scope: InventoryScope,
  consumptionId: string,
  after?: string,
) {
  if (!id(consumptionId)) throw Error('Не выбран исходный расход');
  return (
    await readPage(
      session,
      scope,
      '/inventory/room-outputs/slurry/materials',
      copyMaterial,
      (r) => r.id,
      after,
      {consumptionId},
    )
  ).page;
}
export async function loadCustodyRecipients(
  session: HybridSession,
  scope: InventoryScope,
  outputLotId: string,
  after?: string,
) {
  if (!id(outputLotId)) throw Error('Не выбран выпуск');
  const {raw, page} = await readPage(
    session,
    scope,
    '/inventory/room-handoffs/options',
    copyRecipient,
    (r) => r.id,
    after,
    {outputLotId},
  );
  if (
    !Number.isSafeInteger(raw.destinationStepNumber) ||
    raw.destinationStepNumber < 1 ||
    raw.destinationStepNumber > 2147483647 ||
    !text(raw.destinationWorkshopId)
  )
    throw Error('Некорректный следующий шаг маршрута');
  return {
    ...page,
    destinationStepNumber: raw.destinationStepNumber as number,
    destinationWorkshopId: raw.destinationWorkshopId as string,
  };
}
export async function loadRoomHandoffs(
  session: HybridSession,
  scope: InventoryScope,
  room: 'slurry' | 'coating',
  after?: string,
) {
  return (
    await readPage(
      session,
      scope,
      `/inventory/room-handoffs/${room}`,
      copyRoomHandoff,
      (r) => r.operationId,
      after,
    )
  ).page;
}
export async function loadHandoffEvents(
  session: HybridSession,
  scope: InventoryScope,
  room: 'slurry' | 'coating',
  handoffId: string,
  after?: string,
) {
  if (!id(handoffId)) throw Error('Не выбрана передача');
  return (
    await readPage(
      session,
      scope,
      `/inventory/room-handoffs/${room}/${handoffId}/events`,
      (v) => {
        const r = copyReceipt(v);
        if (r.handoffId !== handoffId) throw Error('Чужая история передачи');
        return r;
      },
      (r) => r.operationId,
      after,
    )
  ).page;
}
export function roomCustodyProposals(scope: InventoryScope, actor: string) {
  return inventoryOutbox.receivingDrafts
    .filter((row) => {
      try {
        const k = JSON.parse(row.key);
        return k[0] === inventoryScopeKey(scope) && k[1] === actor && k[2] === 'room-custody';
      } catch {
        return false;
      }
    })
    .toArray();
}
function copyBase(command: CustodyCommand, base: unknown): CustodyBase {
  return command === 'declaration'
    ? copySlurrySource(base)
    : command === 'handoff'
      ? copyOutputLot(base)
      : copyRoomHandoff(base);
}
function validateIntent(
  command: CustodyCommand,
  request: CustodyRequest,
  base: CustodyBase,
  scope: InventoryScope,
) {
  if (request.deviceId !== scope.deviceId) throw Error('Исходное устройство изменено');
  if (command === 'declaration') {
    const r = request as SlurryOutputRequest,
      s = base as SlurryOutputSource;
    if (!s.eligible || s.declarationId !== null || r.consumptionId !== s.operationId)
      throw Error('Исходный расход удержан или уже имеет выпуск');
    copyDeclaration({
      ...r,
      productionBatchId: s.productionBatchId,
      stepNumber: s.stepNumber,
      inputQuantity: s.inputQuantity,
      source: s.sourceSnapshot,
      actorId: scope.actorId,
      recordedAt: new Date().toISOString(),
      qualityStatus: 'unreviewed',
      warehouseEffect: 'none',
    });
  } else if (command === 'handoff') {
    const r = request as RoomHandoffRequest,
      l = base as SlurryOutputLot;
    if (
      !l.eligible ||
      r.outputLotId !== l.id ||
      r.quantity > l.available ||
      r.expectedSourceRevision !== l.revision ||
      r.destinationStepNumber <= l.stepNumber
    )
      throw Error('Передача превышает исходный остаток или шаг изменён');
  } else {
    const r = request as RoomReceiptRequest,
      h = base as RoomHandoffRead;
    if (
      h.recipientId !== scope.actorId ||
      h.status === 'received' ||
      r.handoffId !== h.operationId ||
      (r.kind === 'receive' && (!h.eligible || r.observedQuantity !== h.quantity))
    )
      throw Error('Требуется назначенный получатель и точное получение; расхождение сохраните отдельно');
  }
}
export async function freezeRoomCustody(
  scope: InventoryScope,
  localActorId: string,
  epoch: string,
  command: CustodyCommand,
  input: CustodyRequest,
  source: CustodyBase,
) {
  const user = await db.users.get(localActorId),
    request = copyCustodyRequest(command, input),
    base = copyBase(command, source);
  if (!user?.isActive || !id(epoch)) throw Error('Неизвестный автор или история');
  validateIntent(command, request, base, scope);
  return inventoryOutbox.transaction('rw', inventoryOutbox.receivingDrafts, async () => {
    const key = JSON.stringify([inventoryScopeKey(scope), localActorId, 'room-custody', request.operationId]),
      existing = await inventoryOutbox.receivingDrafts.get(key);
    if (existing) {
      if (
        existing.fields.request === JSON.stringify(input) &&
        existing.fields.epoch === epoch &&
        same(JSON.parse(existing.fields.source), base)
      )
        return existing;
      throw Error('Исходное предложение уже удержано');
    }
    const related = await inventoryOutbox.receivingDrafts
      .filter((row) => {
        try {
          const k = JSON.parse(row.key);
          if (k[2] !== 'room-custody') return false;
          const r = JSON.parse(row.fields.request);
          return (
            r.operationId === request.operationId ||
            (command === 'declaration' &&
              row.fields.command === 'declaration' &&
              r.consumptionId === (request as SlurryOutputRequest).consumptionId) ||
            (command === 'handoff' &&
              row.fields.command === 'handoff' &&
              row.fields.state === 'pending' &&
              r.outputLotId === (request as RoomHandoffRequest).outputLotId) ||
            (command === 'receipt' &&
              row.fields.command === 'receipt' &&
              r.kind === 'receive' &&
              (request as RoomReceiptRequest).kind === 'receive' &&
              r.handoffId === (request as RoomReceiptRequest).handoffId)
          );
        } catch {
          return false;
        }
      })
      .first();
    if (related) throw Error('Источник удержан исходным предложением; сначала выполните сверку');
    const row: ReceivingDraft = {
      key,
      revision: 1,
      operationId: request.operationId,
      fields: {
        state: 'pending',
        command,
        epoch,
        source: JSON.stringify(base),
        localRole: user.role,
        request: JSON.stringify(input),
      },
    };
    await inventoryOutbox.receivingDrafts.add(row);
    return row;
  });
}
const endpoints = {
  declaration: '/inventory/room-outputs/slurry',
  handoff: '/inventory/room-handoffs',
  receipt: '/inventory/room-handoffs/acknowledgements',
};
export function sendRoomCustody(session: HybridSession, scope: InventoryScope, actor: string, key: string) {
  return withInventorySync(scope, async () => {
    const row = (await roomCustodyProposals(scope, actor)).find((r) => r.key === key);
    if (
      !row ||
      row.fields.state !== 'pending' ||
      !Object.prototype.hasOwnProperty.call(endpoints, row.fields.command)
    )
      throw Error('Нет исходного ожидающего движения');
    const command = row.fields.command as CustodyCommand,
      request = copyCustodyRequest(command, JSON.parse(row.fields.request)),
      base = copyBase(command, JSON.parse(row.fields.source)),
      user = await db.users.get(actor);
    if (
      !user?.isActive ||
      user.role !== row.fields.localRole ||
      request.operationId !== row.operationId ||
      !same(JSON.parse(row.fields.request), request) ||
      !same(JSON.parse(row.fields.source), base)
    )
      throw Error('Исходный автор или предложение изменено');
    validateIntent(command, request, base, scope);
    const context = await loadInventoryIssueContext(session, scope);
    if (context.epoch !== row.fields.epoch || !context.postingEnabled)
      throw Error('История изменилась; исходное движение удержано');
    const response = await inventoryRequest(session, scope, endpoints[command], {
      method: 'POST',
      headers: {'x-inventory-epoch': row.fields.epoch},
      body: row.fields.request,
    });
    async function commit(fields: Record<string, string>) {
      await inventoryOutbox.transaction('rw', inventoryOutbox.receivingDrafts, async () => {
        if (!same(await inventoryOutbox.receivingDrafts.get(key), row))
          throw Error('Исходное предложение изменилось при ожидании ответа');
        await inventoryOutbox.receivingDrafts.put({
          ...row!,
          revision: row!.revision + 1,
          fields: {...row!.fields, ...fields},
        });
      });
    }
    if ([400, 404, 409].includes(response.status)) {
      await commit({
        state: response.status === 409 ? 'conflict' : 'rejected',
        error: 'HTTP ' + response.status,
      });
      throw Error('Движение не принято; исходные данные сохранены: HTTP ' + response.status);
    }
    if (![200, 201].includes(response.status))
      throw Error('Ответ неизвестен / доступ утрачен; повторите исходный ID: HTTP ' + response.status);
    const raw = await response.json(),
      result =
        command === 'declaration'
          ? copyDeclaration(raw?.declaration)
          : command === 'handoff'
            ? copyHandoff(raw?.handoff)
            : copyReceipt(raw?.receipt);
    const expected =
      command === 'declaration'
        ? {
            ...request,
            productionBatchId: (base as SlurryOutputSource).productionBatchId,
            stepNumber: (base as SlurryOutputSource).stepNumber,
            inputQuantity: (base as SlurryOutputSource).inputQuantity,
            source: (base as SlurryOutputSource).sourceSnapshot,
            actorId: scope.actorId,
            recordedAt: result.recordedAt,
            qualityStatus: 'unreviewed',
            warehouseEffect: 'none',
          }
        : command === 'handoff'
          ? {
              ...request,
              productionBatchId: (base as SlurryOutputLot).productionBatchId,
              sourceRoom: 'slurry',
              destinationRoom: 'coating',
              recipientWorkshopId: (result as ReturnType<typeof copyHandoff>).recipientWorkshopId,
              sourceSnapshot: (base as SlurryOutputLot).sourceSnapshot,
              actorId: scope.actorId,
              recordedAt: result.recordedAt,
              unit: 'mg',
              warehouseEffect: 'none',
            }
          : {
              ...request,
              sourceSnapshot: copyHandoff(base),
              actorId: scope.actorId,
              recordedAt: result.recordedAt,
              custodyEffect: (request as RoomReceiptRequest).kind === 'receive' ? 'received' : 'none',
              unit: 'mg',
              warehouseEffect: 'none',
            };
    if (
      raw?.status !== (response.status === 201 ? 'confirmed' : 'duplicate') ||
      raw.operationId !== request.operationId ||
      !same(result, expected)
    )
      throw Error('Ответ не совпадает с исходным движением');
    await commit({
      state: 'accepted',
      acknowledgement: JSON.stringify({
        status: raw.status,
        operationId: request.operationId,
        [command]: result,
      }),
    });
  });
}

/** A blank measurement is never coerced to zero. */
export function measuredMg(value: string, allowZero = false) {
  if (allowZero && /^0+(?:[.,]0+)?$/.test(value.trim())) return 0;
  return toInventoryBaseUnits(value, 'g', 'mg');
}
