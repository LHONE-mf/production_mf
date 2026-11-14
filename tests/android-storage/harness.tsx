/** Instrumentation-only entry. This file is never part of the production build. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmedStorage } from '../../src/stages/storage/ConfirmedStorage';
import { setServerConnection, type ServerConnection } from '../../src/core/sync/serverConnection';
import { obtainDeviceProof } from '../../src/core/sync/deviceProofClient';
import { loadWarehouseAccess } from '../../src/core/sync/inventoryCatalogClient';
import { inventoryOutbox, inventoryQueueForScope, confirmedInventoryForScope, type InventoryScope } from '../../src/core/sync/inventoryOutbox';
import { useAuthStore } from '../../src/core/store/authStore';
import { UserRole } from '../../src/core/types';
import { db } from '../../src/core/db';
import '../../src/index.css';

type Fixture = { serverUrl: string; organizationId: string; password: string; chief: string; operator: string; materialId: string; locationId: string; destinationId: string };
const root = createRoot(document.getElementById('root')!);
const originalFetch = window.fetch.bind(window);
let offline = false, loseAck = false, connection: ServerConnection, fixture: Fixture;
const connections: Partial<Record<'chief' | 'operator', ServerConnection>> = {};
window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (url.origin === 'http://127.0.0.1:3002') {
    if (offline) throw new TypeError('CI network disconnected');
    const response = await originalFetch(input, init);
    if (loseAck && url.pathname === '/inventory/receipts' && response.ok) {
      loseAck = false;
      await response.arrayBuffer(); // Real transaction committed; only the acknowledgement is lost.
      throw new TypeError('CI acknowledgement lost after commit');
    }
    return response;
  }
  return originalFetch(input, init);
};
const scope = (): InventoryScope => ({ serverUrl: connection.serverUrl, organizationId: connection.organizationId, actorId: connection.serverActorId, deviceId: connection.selectedDeviceId });
const assert = (condition: unknown, message: string) => { if (!condition) throw Error(message); };
async function until(check: () => unknown | Promise<unknown>, label: string) {
  const deadline = Date.now() + 25_000;
  while (!await check()) {
    assert(Date.now() < deadline, 'Timed out: ' + label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
async function post(path: string, body: unknown, token: string) {
  const response = await fetch(fixture.serverUrl + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) });
  assert(response.ok, 'API failed: ' + path + ' HTTP ' + response.status);
  return response.json();
}
async function connect(input: Fixture) {
  fixture = input;
  assert(fixture.serverUrl === 'http://127.0.0.1:3002', 'Disposable loopback only');
  const native = (window as unknown as { Capacitor: { nativePromise: (plugin: string, method: string, args: object) => Promise<any> } }).Capacitor;
  const key = await native.nativePromise('DeviceProof', 'getPublicKey', {});
  let chiefToken = '';
  for (const role of ['chief', 'operator'] as const) {
    const login = await post('/auth/login', { organizationId: fixture.organizationId, login: fixture[role], password: fixture.password }, '');
    if (role === 'chief') chiefToken = login.accessToken;
    const devices = await originalFetch(fixture.serverUrl + '/devices/mine', { headers: { authorization: 'Bearer ' + login.accessToken } }).then(response => response.json());
    const deviceId = devices.devices[0]?.id ?? (await post('/devices', { userId: fixture[role], publicKey: key.publicKey }, chiefToken)).id;
    const session = await obtainDeviceProof({ serverUrl: fixture.serverUrl, accessToken: login.accessToken }, deviceId,
      async challenge => (await native.nativePromise('DeviceProof', 'signChallenge', { challenge })).signature);
    connections[role] = { serverUrl: fixture.serverUrl, organizationId: fixture.organizationId, serverActorId: login.user.id, serverRole: login.user.role,
      selectedDeviceId: deviceId, enrolledDeviceId: deviceId, myDevices: [deviceId], session };
  }
  const chief = connections.chief!;
  const granted = await originalFetch(fixture.serverUrl + '/inventory/access', { method: 'POST', headers: { authorization: 'Bearer ' + chief.session.accessToken, 'x-device-proof': chief.session.deviceProofToken!, 'content-type': 'application/json' },
    body: JSON.stringify({ changeId: crypto.randomUUID(), deviceId: chief.selectedDeviceId, userId: fixture.operator, level: 'operator', action: 'grant' }) });
  assert(granted.ok, 'Chief must grant explicit warehouse operator access');
  await select('operator');
  return { connected: true };
}
async function select(role: 'chief' | 'operator') {
  connection = connections[role]!;
  const user = { id: fixture[role], login: 'CI-' + role, fullName: 'Synthetic CI ' + role, password: 'not-a-server-credential', role: role === 'chief' ? UserRole.CHIEF : UserRole.WORKER, isActive: true, createdAt: new Date() };
  await db.users.put(user);
  if (useAuthStore.getState().session?.userId === user.id) await useAuthStore.getState().verifyLocalSession();
  else useAuthStore.getState().login(user);
  setServerConnection(connection);
  root.render(<ConfirmedStorage />);
  await until(() => button('Обновить подтверждённые данные'), 'Storage mounted');
}
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text && !b.disabled); }
async function click(text: string) {
  await until(() => button(text), text);
  button(text)!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
}
async function fill(label: string, value: string) {
  await until(() => document.querySelector(`[aria-label="${label}"]`), label);
  const element = document.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  await until(async () => {
    const drafts = await inventoryOutbox.receivingDrafts.toArray();
    return drafts.some(draft => Object.values(draft.fields).includes(value)) &&
      !document.querySelector('[aria-label="Серверная приёмка"]')?.textContent?.includes('Сохранение…');
  }, 'draft persisted');
}
async function refresh() {
  await click('Обновить подтверждённые данные');
  await until(() => button('Обновить подтверждённые данные') && document.body.textContent?.includes('Последняя успешная синхронизация:'), 'real server sync');
}
async function receipt() {
  for (const [label, value] of [['Материал приёмки', fixture.materialId], ['Место приёмки', fixture.locationId], ['Партия производителя', 'CI-SAME-LOT'], ['Количество приёмки', '2.125'], ['Единица приёмки', 'kg'], ['Документ приёмки', 'Synthetic CI delivery'], ['Основание приёмки / свидетельство', 'Synthetic physical receipt evidence']]) await fill(label, value);
  await click('Проверить приёмку'); await click('Сохранить приёмку в очередь');
  await until(async () => (await inventoryQueueForScope(scope())).length === 1, 'frozen receiving intent');
  return (await inventoryQueueForScope(scope()))[0];
}
async function send() { await click('Проверить отправку / повтор'); await click('Подтвердить отправку тех же операций'); }
async function prepare() {
  await refresh();
  const access = await loadWarehouseAccess(connection.session, scope());
  assert(!access.canCorrectStock && !access.canManageCatalog, 'Operator permissions must be restricted');
  offline = true;
  const queued = await receipt();
  assert((await confirmedInventoryForScope(scope())).length === 0, 'No optimistic stock');
  return { operationId: queued.operationId, request: queued.request };
}
async function finish(expected: { operationId: string; request: unknown }) {
  const restored = (await inventoryQueueForScope(scope()))[0];
  assert(restored?.operationId === expected.operationId && JSON.stringify(restored.request) === JSON.stringify(expected.request), 'Process death changed frozen intent');
  assert((await confirmedInventoryForScope(scope())).length === 0, 'Restart invented stock');
  await refresh();
  loseAck = true; await send();
  await until(() => document.querySelector('[role="alert"]'), 'lost ACK displayed');
  assert((await inventoryQueueForScope(scope()))[0]?.operationId === expected.operationId, 'Unknown outcome lost original intent');
  await refresh(); await send();
  await until(async () => (await inventoryQueueForScope(scope())).length === 0, 'idempotent ACK');
  await refresh();
  const stock = (await confirmedInventoryForScope(scope()))[0];
  assert(stock?.onHand === 2_125_000 && stock.quality === 'quarantine', 'Exact receipt must stay quarantined');
  // A malicious operator POST must fail at the real server, independently of UI concealment.
  const epoch = (await inventoryOutbox.streams.toArray())[0].epoch;
  const denied = await originalFetch(fixture.serverUrl + '/inventory/stocks/' + stock.stockId + '/operations', {
    method: 'POST', headers: { authorization: 'Bearer ' + connection.session.accessToken, 'content-type': 'application/json', 'x-device-proof': connection.session.deviceProofToken!, 'x-inventory-epoch': epoch },
    body: JSON.stringify({ operationId: crypto.randomUUID(), deviceId: connection.selectedDeviceId, kind: 'adjust', expectedRevision: stock.revision, quantity: 1, adjustment: 'increase', reason: 'Forbidden CI operator correction' }) });
  assert(denied.status === 403, 'Server accepted unauthorized correction: ' + denied.status);
  await click('Другая упаковка'); await click('Да, другая физическая упаковка');
  const second = await receipt(); assert(second.request.stockId !== stock.stockId, 'Same-lot containers merged');
  await send(); await until(async () => (await inventoryQueueForScope(scope())).length === 0, 'second receipt accepted'); await refresh();
  assert((await confirmedInventoryForScope(scope())).length === 2, 'Second distinct package missing');
  assert(![...document.querySelectorAll('option')].some(option => option.textContent === 'Коррекция количества'), 'Operator correction exposed');
  assert(document.documentElement.scrollWidth <= innerWidth, 'Horizontal overflow');
  await useAuthStore.getState().logout();
  await until(() => !document.body.textContent?.includes('На руках:'), 'logout conceals confirmed cache');
  assert((await inventoryOutbox.acknowledgements.count()) === 2, 'Logout destroyed retained evidence');
  return { passed: true, operationId: expected.operationId, nativeProof: true, exactQuantity: 2_125_000, containers: 2, quarantine: true, lostAckRetried: true, operatorDenied: true, logoutConcealed: true };
}
(window as unknown as { storageCi: unknown }).storageCi = { connect, prepare, finish };
