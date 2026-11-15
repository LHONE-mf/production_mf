/** Instrumentation-only entry. This file is never part of the production build. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfirmedStorage } from '../../src/stages/storage/ConfirmedStorage';
import { InventoryIssues } from '../../src/stages/storage/InventoryIssues';
import { inventoryIssueProposals } from '../../src/core/sync/inventoryIssues';
import { inventoryOutcomeProposals } from '../../src/core/sync/inventoryOutcomes';
import { inventoryStockQueueForScope } from '../../src/core/sync/inventoryStockOutbox';
import { inventorySplitProposals } from '../../src/core/sync/inventorySplits';
import { parseInventoryLabel } from '../../src/core/sync/inventoryIdentification';
import { inventoryCountProposals,loadInventoryCountEvents } from '../../src/core/sync/inventoryCounts';
import {inventoryLabel} from '../../src/core/sync/inventoryIdentification';
import { setServerConnection, type ServerConnection } from '../../src/core/sync/serverConnection';
import { obtainDeviceProof } from '../../src/core/sync/deviceProofClient';
import { preflightInventoryStream } from '../../src/core/sync/inventoryClient';
import { inventoryQualityProposals } from '../../src/core/sync/inventoryQuality';
import { listInventoryAdministration } from '../../src/core/sync/inventoryAdministration';
import { loadWarehouseAccess } from '../../src/core/sync/inventoryCatalogClient';
import { inventoryOutbox, inventoryQueueForScope, confirmedInventoryForScope, type InventoryScope } from '../../src/core/sync/inventoryOutbox';
import { useAuthStore } from '../../src/core/store/authStore';
import { UserRole } from '../../src/core/types';
import { db } from '../../src/core/db';
import '../../src/index.css';

type Fixture = { serverUrl: string; organizationId: string; password: string; chief: string; operator: string; materialId: string; locationId: string; destinationId: string; batchId:string;workshopId:string;stepNumber:number };
const root = createRoot(document.getElementById('root')!);
const originalFetch = window.fetch.bind(window);
let offline = false, loseAck = false, loseIssueAck = false, loseReturnAck = false, loseSplitAck=false, loseCountAck=false, connection: ServerConnection, fixture: Fixture;
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
    if(loseIssueAck && /^\/inventory\/issues\/[^/]+\/operations$/.test(url.pathname) && response.ok){loseIssueAck=false;await response.arrayBuffer();throw new TypeError('CI issue acknowledgement lost after commit');}
    if(loseReturnAck&&url.pathname.endsWith('/outcomes')&&init?.method==='POST'&&response.ok){loseReturnAck=false;await response.arrayBuffer();throw new TypeError('CI return acknowledgement lost after commit');}
    if(loseSplitAck&&url.pathname.endsWith('/splits')&&init?.method==='POST'&&response.ok){loseSplitAck=false;await response.arrayBuffer();throw new TypeError('CI split acknowledgement lost after commit');}
    if(loseCountAck&&url.pathname==='/inventory/counts/operations'&&init?.method==='POST'&&response.ok){loseCountAck=false;await response.arrayBuffer();throw new TypeError('CI count acknowledgement lost after commit');}
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
  const epoch = await preflightInventoryStream(chief.session, { serverUrl: chief.serverUrl, organizationId: chief.organizationId, actorId: chief.serverActorId, deviceId: chief.selectedDeviceId });
  const granted = await originalFetch(fixture.serverUrl + '/inventory/access', { method: 'POST', headers: { authorization: 'Bearer ' + chief.session.accessToken, 'x-device-proof': chief.session.deviceProofToken!, 'x-inventory-epoch': epoch, 'content-type': 'application/json' },
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
  root.render(<><ConfirmedStorage /><InventoryIssues /></>);
  await until(() => button('Обновить подтверждённые данные'), 'Storage mounted');
}
function button(text: string, root: ParentNode = document) { return [...root.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text && !b.disabled); }
async function click(text: string, root: ParentNode = document) {
  await until(() => button(text, root), text);
  button(text, root)!.click();
  await new Promise(resolve => setTimeout(resolve, 0));
}
async function fill(label: string, value: string, persisted = true, root: ParentNode = document) {
  await until(() => {
    const control = root.querySelector(`[aria-label="${label}"]`);
    return control && !control.matches(':disabled') && (!(control instanceof HTMLSelectElement) || [...control.options].some(option => option.value === value));
  }, label);
  const element = root.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
  element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  if (!persisted) { await until(() => element.value === value, 'form field: ' + label); return; }
  await until(async () => {
    const drafts = await inventoryOutbox.receivingDrafts.toArray();
    return drafts.some(draft => Object.values(draft.fields).includes(value)) &&
      !document.querySelector('[aria-label="Серверная приёмка"]')?.textContent?.includes('Сохранение…');
  }, 'draft persisted: ' + label);
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
async function refreshIssues(){await click('Обновить запросы и доступные партии');await until(()=>button('Обновить запросы и доступные партии')&&document.querySelector('[aria-label="Запрос материала в производство"]'),'issue scope loaded');}
async function prepareIssueRequest(){
  await refreshIssues();
  await fill('Производственная партия и шаг',fixture.batchId+':1',false);await click('Загрузить материалы и получателей шага');
  await fill('Материал для производства',fixture.materialId,false);await fill('Назначенный получатель',fixture.operator,false);await fill('Запрашиваемое количество','500000',false);
  await fill('Основание запроса материала','Synthetic native batch requirement',false);await fill('Документ потребности','NATIVE-REQUIREMENT-42',false);
  offline=true;await click('Сохранить запрос без выдачи');
  await until(async()=> (await inventoryIssueProposals(scope(),fixture.operator)).some(r=>r.fields.kind==='request'),'native frozen issue request');
  return (await inventoryIssueProposals(scope(),fixture.operator)).find(r=>r.fields.kind==='request')!;
}
async function prepare() {
  await select('chief'); await refresh();
  const open = (text: string) => { const summary = [...document.querySelectorAll('summary')].find(row => row.textContent === text); assert(summary, 'Missing native admin section'); summary!.click(); };
  open('Администрирование склада · Chief');
  await fill('Код материала', 'NATIVE-ADMIN', false); await fill('Название материала', 'Native synthetic component', false);
  await fill('Категория материала', 'component', false); await fill('Базовая единица', 'pieces', false);
  await click('Проверить новый материал');
  await until(async () => (await listInventoryAdministration(scope(), fixture.chief)).some(row => row.fields.kind === 'material'), 'native catalogue proposal');
  const creation = (await listInventoryAdministration(scope(), fixture.chief)).find(row => row.fields.kind === 'material')!;
  await click('Подтвердить отправку предложения ' + creation.operationId!.slice(0, 8));
  await until(async () => (await inventoryOutbox.receivingDrafts.get(creation.key))?.fields.state === 'accepted', 'native catalogue accepted');
  await until(() => button('Обновить подтверждённые данные'), 'catalogue refresh complete');
  open('Изменить справочники');
  await fill('Материал для изменения', creation.operationId!, false);
  await fill('Новое название материала', 'Native corrected component', false); await fill('Артикул поставщика', 'NATIVE-ITEM-42', false);
  await fill('Основание изменения материала', 'Synthetic supplier document checked on Android', false);
  await click('Проверить изменение материала');
  await until(async () => (await listInventoryAdministration(scope(), fixture.chief)).some(row => row.fields.kind === 'material_change'), 'native catalogue edit proposal');
  const edit = (await listInventoryAdministration(scope(), fixture.chief)).find(row => row.fields.kind === 'material_change')!;
  assert(JSON.parse(edit.fields.request).expectedRevision === 1, 'Native editor did not freeze original version');
  await click('Подтвердить отправку предложения ' + edit.operationId!.slice(0, 8));
  await until(async () => (await inventoryOutbox.receivingDrafts.get(edit.key))?.fields.state === 'accepted', 'native catalogue edit accepted');
  await select('operator');
  await refresh();
  const access = await loadWarehouseAccess(connection.session, scope());
  assert(!access.canCorrectStock && !access.canManageCatalog, 'Operator permissions must be restricted');
  const issueRequest=await prepareIssueRequest();
  const queued = await receipt();
  assert((await confirmedInventoryForScope(scope())).length === 0, 'No optimistic stock');
  return { operationId: queued.operationId, request: queued.request, issueOperationId:issueRequest.operationId,issueRequest:issueRequest.fields.request };
}
async function finish(expected: { operationId: string; request: unknown;issueOperationId:string;issueRequest:string }) {
  const frozenIssue=(await inventoryIssueProposals(scope(),fixture.operator)).find(r=>r.operationId===expected.issueOperationId);
  assert(frozenIssue?.fields.request===expected.issueRequest&&frozenIssue.fields.state==='pending','Process death changed frozen issue request');
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
  const operatorQa = await originalFetch(fixture.serverUrl + '/inventory/stocks/' + stock.stockId + '/quality-dispositions', { method: 'POST', headers: { authorization: 'Bearer ' + connection.session.accessToken, 'content-type': 'application/json', 'x-device-proof': connection.session.deviceProofToken!, 'x-inventory-epoch': epoch }, body: JSON.stringify({ operationId: crypto.randomUUID(), stockId: stock.stockId, deviceId: connection.selectedDeviceId, expectedRevision: stock.revision, disposition: 'release', reason: 'Forbidden operator QA', evidence: 'Forbidden' }) });
  assert(operatorQa.status === 403, 'Server accepted operator QA release');
  await select('chief'); await refresh();
  const article = [...document.querySelectorAll('article')].find(row => [...row.querySelectorAll('p')].some(text => text.textContent === 'Контейнер: ' + stock.stockId));
  assert(article, 'Chief cannot see genuine received package');
  const summary = [...article!.querySelectorAll('summary')].find(row => row.textContent === 'Решения о качестве / история'); assert(summary, 'QA screen missing'); summary!.click();
  await fill('Решение о качестве', 'release', false, article!); await fill('Основание решения Chief', 'Native Chief certificate review', false, article!); await fill('Документ / свидетельство QA', 'NATIVE-QA-42', false, article!); await click('Проверить решение о качестве', article!);
  await until(async () => (await inventoryQualityProposals(scope(), fixture.chief, stock.stockId)).length === 1, 'native Chief frozen QA');
  const qa = (await inventoryQualityProposals(scope(), fixture.chief, stock.stockId))[0];
  await click('Подтвердить решение Chief ' + qa.operationId!.slice(0, 8), article!); await until(async () => (await inventoryOutbox.receivingDrafts.get(qa.key))?.fields.state === 'accepted', 'native genuine QA release');
  await refresh(); const released = (await confirmedInventoryForScope(scope())).find(row => row.stockId === stock.stockId);
  assert(released?.quality === 'released' && released.onHand === 2_125_000 && released.disposition === 'release', 'Native QA release altered quantity or missed genuine source');
  const issueId=await finishIssue(stock.stockId,expected.issueOperationId);
  const returned=await finishReturn(issueId,stock.stockId);
  await finishReconciliation(issueId,stock.stockId);
  const warehouseWaste=await finishWarehouseScrap(returned.returnStockId);
  const split=await finishSplit(stock.stockId);
  const count=await finishCount(split.splitChildId);
  await finishMovementAudit(issueId,stock.stockId,returned.returnStockId,split.splitChildId,count.countObservationOperationId!,count.countCorrectionOperationId!);
  const identification=await finishIdentification(split.splitChildId);
  await useAuthStore.getState().logout();
  await until(() => !document.body.textContent?.includes('На руках:'), 'logout conceals confirmed cache');
  assert((await inventoryOutbox.acknowledgements.count()) === 10, 'Logout destroyed retained evidence');
  return { passed: true, operationId: expected.operationId, nativeProof: true, exactQuantity: 2_125_000, containers: 4, quarantineOnReceipt: true, chiefQaRelease: true, operatorQaDenied: true, lostAckRetried: true, operatorDenied: true, logoutConcealed: true,issueId,issuedQuantity:500000,issueProcessDeath:true,chiefIssueApproved:true,issueLostAckRetried:true,assignedReceipt:true,issueNotConsumption:true,nativeMovementAudit:true,nativeIssueReconciliation:true,reconciledOutstanding:300000,...returned,...warehouseWaste,...split,...count,...identification };
}
async function finishReconciliation(issueId:string,stockId:string){
  await select('operator');await refresh();
  const panel=document.querySelector<HTMLDetailsElement>('[aria-label="Сверка выданных материалов"]');assert(panel,'Native reconciliation panel missing');panel!.open=true;
  await fill('Партия производства для сверки',fixture.batchId,false,panel!);
  await fill('Получатель для сверки',fixture.operator,false,panel!);
  await fill('Материал сверки выдач',fixture.materialId,false,panel!);
  await fill('Исходный контейнер для сверки',stockId,false,panel!);
  await click('Показать сверку выдач',panel!);
  await until(()=>panel!.querySelector('[aria-label="Сверка выдачи '+issueId+'"]'),'native received issue report');
  const text=panel!.querySelector('[aria-label="Сверка выдачи '+issueId+'"]')!.textContent!;
  assert(text.includes('Принято: 500000')&&text.includes('Возвращено: 200000')&&text.includes('Списано из выдачи: 0')&&text.includes('Неразнесено: 300000'),'Native reconciliation quantities differ from accepted handoff/return');
  assert(text.includes('Фактический расход: НЕ ЗАПИСАН'),'Native report invented actual consumption');
  assert(document.documentElement.scrollWidth<=innerWidth,'Native reconciliation overflow');panel!.open=false;
  const movements=document.querySelector<HTMLDetailsElement>('[aria-label="Журнал движений склада"]');assert(movements,'Native movements panel missing');movements!.open=true;
  await fill('Фильтр по историческому месту',fixture.locationId,false,movements!);await click('Показать журнал',movements!);
  await until(()=>movements!.querySelector('[aria-label^="Операция склада "]'),'native location-scoped ledger');
  await fill('Фильтр по историческому месту',crypto.randomUUID(),false,movements!);await click('Показать журнал',movements!);
  await until(()=>movements!.textContent?.includes('Записей в выбранной области нет.'),'native other-location empty ledger');movements!.open=false;
}
async function finishMovementAudit(issueId:string,sourceId:string,returnId:string,childId:string,observationId:string,correctionId:string){
  const panel=document.querySelector<HTMLDetailsElement>('[aria-label="Журнал движений склада"]');assert(panel,'Native movement audit panel missing');panel!.open=true;
  await fill('Фильтр по историческому месту','',false,panel!);await fill('Фильтр по типу движения','',false,panel!);await click('Показать журнал',panel!);
  await until(()=>panel!.querySelector('[aria-label="Операция склада '+correctionId+'"]'),'native approved-count audit row');
  const counted=panel!.querySelector('[aria-label="Подробности коррекции пересчёта"]')!.textContent!;
  assert(counted.includes(observationId)&&counted.includes('125000')&&counted.includes('124000')&&counted.includes('Расхождение: -1000')&&counted.includes(fixture.operator)&&counted.includes(fixture.chief),'Native count audit lost original observer/approval/quantity');
  assert(panel!.querySelector('[aria-label="Подробности решения QA"]')?.textContent?.includes('Разрешено'),'Native QA audit missing');
  const split=panel!.querySelector('[aria-label="Подробности разделения упаковки"]')!.textContent!;
  assert(split.includes(sourceId)&&split.includes(childId),'Native split audit lost parent/child');
  const returned=panel!.querySelector('[aria-label="Подробности происхождения возврата"]')!.textContent!;
  assert(returned.includes(issueId)&&returned.includes(sourceId)&&returned.includes(returnId),'Native return audit lost provenance');
  assert(document.documentElement.scrollWidth<=innerWidth,'Native movement audit overflow');panel!.open=false;
}
async function finishIssue(stockId:string,requestId:string){
  await select('operator');await refreshIssues();
  await click('Отправить сохранённое действие '+requestId.slice(0,8));
  await until(async()=> (await inventoryIssueProposals(scope(),fixture.operator)).some(r=>r.operationId===requestId&&r.fields.state==='accepted'),'native request accepted');
  const request=(await inventoryIssueProposals(scope(),fixture.operator)).find(r=>r.operationId===requestId)!,issueId=JSON.parse(request.fields.intent).issueId as string;
  const denied=await originalFetch(fixture.serverUrl+'/inventory/issues/'+issueId+'/operations',{method:'POST',headers:{authorization:'Bearer '+connection.session.accessToken,'content-type':'application/json','x-device-proof':connection.session.deviceProofToken!,'x-inventory-epoch':request.fields.epoch},body:JSON.stringify({operationId:crypto.randomUUID(),deviceId:connection.selectedDeviceId,kind:'dispatch',expectedIssueRevision:1,expectedStockRevision:2,reason:'Forbidden native operator dispatch',evidence:'Must be denied'})});
  assert(denied.status===403,'Native operator self-authorized issue');
  await select('chief');await refreshIssues();
  async function prepareAction(kind:'reserve'|'approve'|'dispatch'){
    const card=document.querySelector<HTMLElement>('[aria-label="Выдача '+issueId+'"]');assert(card,'Native issue card missing');
    await click('Загрузить контейнеры материала',card!);
    await until(()=>button('Загрузить контейнеры материала',card!)&&card!.textContent?.includes('Последний прочитанный контейнер:')||kind==='reserve'&&!!card!.querySelector('option[value="'+stockId+'"]'),'native issue source loaded');
    if(kind==='reserve')await fill('Исходный контейнер',stockId,false,card!);
    await fill('Действие выдачи',kind,false,card!);await fill('Основание выдачи','Native actual physical handoff: '+kind,false,card!);await fill('Свидетельство передачи / одобрения','NATIVE-ISSUE-42 '+kind,false,card!);
    await click('Сохранить действие для отдельного подтверждения',card!);await until(async()=> (await inventoryIssueProposals(scope(),fixture.chief)).some(r=>r.fields.kind===kind),'native frozen '+kind);
    return (await inventoryIssueProposals(scope(),fixture.chief)).find(r=>r.fields.kind===kind)!;
  }
  for(const kind of ['reserve','approve','dispatch'] as const){
    const action=await prepareAction(kind);if(kind==='dispatch')loseIssueAck=true;
    await click('Отправить сохранённое действие '+action.operationId!.slice(0,8));
    if(kind==='dispatch'){
      await until(()=>document.querySelector('[aria-label="Запросы и выдача в производство"] [role="alert"]'),'native lost issue ACK');
      assert((await inventoryOutbox.receivingDrafts.get(action.key))?.fields.state==='pending','Native lost issue ACK erased intent');await click('Отправить сохранённое действие '+action.operationId!.slice(0,8));
    }
    await until(async()=> (await inventoryOutbox.receivingDrafts.get(action.key))?.fields.state==='accepted','native '+kind+' accepted');
    await until(()=>button('Обновить запросы и доступные партии'),'native issue refresh complete');
  }
  await select('operator');await refreshIssues();
  const card=document.querySelector<HTMLElement>('[aria-label="Выдача '+issueId+'"]');assert(card&&!button('Загрузить контейнеры материала',card!),'Operator exposed Manager controls');
  await fill('Основание выдачи','Assigned native recipient received physical package',false,card!);await fill('Свидетельство передачи / одобрения','NATIVE-RECEIPT-42',false,card!);await click('Сохранить действие для отдельного подтверждения',card!);
  await until(async()=> (await inventoryIssueProposals(scope(),fixture.operator)).some(r=>r.fields.kind==='receive'),'native frozen recipient receipt');
  const receipt=(await inventoryIssueProposals(scope(),fixture.operator)).find(r=>r.fields.kind==='receive')!;await click('Отправить сохранённое действие '+receipt.operationId!.slice(0,8));
  await until(async()=> (await inventoryOutbox.receivingDrafts.get(receipt.key))?.fields.state==='accepted','native assigned receipt accepted');
  await refresh();assert((await confirmedInventoryForScope(scope())).find(s=>s.stockId===stockId)?.onHand===1625000,'Recipient deducted twice or inferred consumption');
  assert(document.documentElement.scrollWidth<=innerWidth,'Native issues overflow');return issueId;
}
async function finishReturn(issueId:string,sourceStockId:string){
  await refresh();await click('Загрузить источники возврата');
  const panel=document.querySelector<HTMLElement>('[aria-label="Возвраты и списание выданного"]');assert(panel,'Native return screen missing');
  await fill('Полученная выдача для возврата',issueId,false,panel!);await fill('Количество возврата / списания','200000',false,panel!);await fill('Место возврата',fixture.locationId,false,panel!);await fill('Состояние возврата','untouched_unused',false,panel!);
  await fill('Основание возврата / списания','Native untouched issued material physically returned',false,panel!);await fill('Свидетельство состояния / списания','NATIVE-RETURN-CONDITION-42',false,panel!);
  assert(![...panel!.querySelectorAll('option')].some(o=>o.value==='scrap'),'Operator exposed Manager scrap');
  offline=true;await click('Сохранить возврат / списание без проведения',panel!);await until(async()=> (await inventoryOutcomeProposals(scope(),fixture.operator)).length===1,'native frozen return');
  const row=(await inventoryOutcomeProposals(scope(),fixture.operator))[0],request=JSON.parse(row.fields.request);
  assert((await confirmedInventoryForScope(scope())).length===2,'Offline return invented warehouse stock');
  offline=false;loseReturnAck=true;await click('Подтвердить сохранённый возврат / списание '+row.operationId!.slice(0,8),panel!);
  await until(()=>panel!.querySelector('[role="alert"]'),'native lost return ACK');assert((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.request===row.fields.request,'Native unknown return outcome changed intent');
  assert((await confirmedInventoryForScope(scope())).length===2,'Lost return ACK optimistically changed stock');
  await click('Подтвердить сохранённый возврат / списание '+row.operationId!.slice(0,8),panel!);await until(async()=> (await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state==='accepted','native exact return retry');
  await refresh();const stocks=await confirmedInventoryForScope(scope());
  assert(stocks.length===3&&stocks.find(s=>s.stockId===sourceStockId)?.onHand===1625000,'Return merged into source or debited source again');
  const child=stocks.find(s=>s.stockId===request.stockId);assert(child?.onHand===200000&&child.quality==='released'&&child.disposition==='release','Normal return did not become directly AVAILABLE');
  const headers={authorization:'Bearer '+connection.session.accessToken,'content-type':'application/json','x-device-proof':connection.session.deviceProofToken!,'x-inventory-epoch':row.fields.epoch};
  const denied=await originalFetch(fixture.serverUrl+'/inventory/issues/'+issueId+'/outcomes',{method:'POST',headers,body:JSON.stringify({...request,operationId:crypto.randomUUID(),stockId:crypto.randomUUID(),expectedSettlementRevision:2,quantity:1,condition:'damaged'})});assert(denied.status===409,'Native damaged return became available');
  const scrap=await originalFetch(fixture.serverUrl+'/inventory/issues/'+issueId+'/outcomes',{method:'POST',headers,body:JSON.stringify({operationId:crypto.randomUUID(),deviceId:connection.selectedDeviceId,issueId,productionBatchId:fixture.batchId,sourceStockId,expectedSettlementRevision:2,kind:'scrap',quantity:1,reason:'Forbidden operator scrap',evidence:'Must be denied'})});assert(scrap.status===403,'Native operator gained Manager scrap authority');
  assert(document.documentElement.scrollWidth<=innerWidth,'Native return overflow');
  return {returnStockId:request.stockId,returnOperationId:row.operationId,returnedQuantity:200000,directReturnAvailable:true,returnLostAckRetried:true,invalidReturnDenied:true,operatorScrapDenied:true};
}
async function finishWarehouseScrap(stockId:string){
  const epoch=(await inventoryOutbox.streams.get((await import('../../src/core/sync/inventoryOutbox')).inventoryScopeKey(scope())))!.epoch;
  const denied=await originalFetch(fixture.serverUrl+'/inventory/stocks/'+stockId+'/operations',{method:'POST',headers:{authorization:'Bearer '+connection.session.accessToken,'content-type':'application/json','x-device-proof':connection.session.deviceProofToken!,'x-inventory-epoch':epoch},body:JSON.stringify({operationId:crypto.randomUUID(),deviceId:connection.selectedDeviceId,kind:'scrap',expectedRevision:1,quantity:1000,reason:'Forbidden operator warehouse disposal',evidence:'Must fail'})});assert(denied.status===403,'Operator self-authorized warehouse scrap');
  await select('chief');await refresh();
  const article=[...document.querySelectorAll('article')].find(row=>[...row.querySelectorAll('p')].some(p=>p.textContent==='Контейнер: '+stockId));assert(article,'Native warehouse return package missing');
  // StockChangeForm restores its durable draft asynchronously after stock sync.
  // Wait for the actual control, as browser locators do, before opening it.
  const summary=()=>[...article!.querySelectorAll('summary')].find(s=>s.textContent==='Перемещение / коррекция / списание контейнера');
  await until(summary,'warehouse draft restored and operations available');summary()!.click();
  await fill('Действие склада','scrap',true,article!);await fill('Количество складского списания','1000',true,article!);await fill('Основание изменения','Native actual warehouse disposal of damaged portion',true,article!);await fill('Свидетельство складского списания','NATIVE-WAREHOUSE-WASTE-42',true,article!);
  await click('Проверить изменение',article!);await click('Сохранить изменение в очередь',article!);await until(async()=> (await inventoryStockQueueForScope(scope())).some(r=>r.request.kind==='scrap'),'native frozen warehouse scrap');
  await send();await until(async()=> !(await inventoryStockQueueForScope(scope())).some(r=>r.request.kind==='scrap'),'native warehouse scrap accepted');
  await select('operator');await refresh();assert((await confirmedInventoryForScope(scope())).find(s=>s.stockId===stockId)?.onHand===199000,'Native warehouse scrap did not converge across roles');
  return {warehouseScrapApproved:true,warehouseScrapOperatorDenied:true,warehouseScrappedQuantity:1000};
}
async function finishSplit(stockId:string){
  const forbidden={operationId:crypto.randomUUID(),childOperationId:crypto.randomUUID(),deviceId:connection.selectedDeviceId,parentStockId:stockId,childStockId:crypto.randomUUID(),locationId:fixture.locationId,expectedRevision:4,quantity:125000,reason:'Native operator must not split',evidence:'CI role denial'};
  const epoch=await preflightInventoryStream(connection.session,scope()),denied=await originalFetch(fixture.serverUrl+'/inventory/stocks/'+stockId+'/splits',{method:'POST',headers:{authorization:'Bearer '+connection.session.accessToken,'content-type':'application/json','x-device-proof':connection.session.deviceProofToken!,'x-inventory-epoch':epoch},body:JSON.stringify(forbidden)});assert(denied.status===403,'Native operator authorized split');
  await select('chief');await refresh();const article=[...document.querySelectorAll('article')].find(row=>[...row.querySelectorAll('p')].some(p=>p.textContent==='Контейнер: '+stockId));assert(article,'Native split source missing');
  const panel=article!.querySelector<HTMLElement>('[aria-label="Разделение контейнера '+stockId+'"]');assert(panel,'Native split panel missing');(panel as HTMLDetailsElement).open=true;
  await click('Новый черновик разделения после сверки',panel!);await click('Подтвердить новый черновик разделения',panel!);
  await fill('Количество в дочерней упаковке','125000',true,panel!);await fill('Место дочерней упаковки',fixture.locationId,true,panel!);await fill('Основание разделения','Native Chief authorized partial repack',true,panel!);await fill('Свидетельство взвешивания / переупаковки','NATIVE-CHILD-WEIGHT-42',true,panel!);
  await click('Проверить и сохранить разрешение на разделение',panel!);await until(async()=>(await inventorySplitProposals(scope(),fixture.chief,stockId)).length===1,'native frozen authorized split');const row=(await inventorySplitProposals(scope(),fixture.chief,stockId))[0],request=JSON.parse(row.fields.request);
  loseSplitAck=true;await click('Подтвердить фактическое разделение '+row.operationId!.slice(0,8),panel!);await until(()=>panel!.querySelector('[role="alert"]'),'native lost split ACK');assert((await inventoryOutbox.receivingDrafts.get(row.key))?.fields.request===row.fields.request,'Split ACK loss changed child intent');
  await click('Подтвердить фактическое разделение '+row.operationId!.slice(0,8),panel!);await until(async()=>(await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state==='accepted','native exact split retry');await select('operator');await refresh();
  const stocks=await confirmedInventoryForScope(scope()),parent=stocks.find(s=>s.stockId===stockId),child=stocks.find(s=>s.stockId===request.childStockId);assert(parent?.onHand===1500000&&child?.onHand===125000&&child.reserved===0&&child.quality==='released','Native split conservation/QA mismatch');
  const card=[...document.querySelectorAll('article')].find(row=>[...row.querySelectorAll('p')].some(p=>p.textContent==='Контейнер: '+request.childStockId));assert(card,'Native split child invisible');const label=card!.querySelector<HTMLElement>('[data-inventory-label]')?.dataset.inventoryLabel;assert(label,'Native split child QR/manual code missing');const parsed=parseInventoryLabel(label!,fixture.organizationId);assert(parsed.kind==='container'&&parsed.id===request.childStockId,'Native child label identity mismatch');
  const genealogy=card!.querySelector<HTMLDetailsElement>('[aria-label="Разделение контейнера '+request.childStockId+'"]');assert(genealogy,'Native child genealogy absent');genealogy!.open=true;await click('Загрузить генеалогию разделения',genealogy!);await until(()=>genealogy!.textContent?.includes('NATIVE-CHILD-WEIGHT-42'),'native original split genealogy');assert(document.documentElement.scrollWidth<=innerWidth,'Native split overflow');
  return{splitApproved:true,splitOperatorDenied:true,splitLostAckRetried:true,splitChildLabelResolved:true,splitQuantity:125000,splitOperationId:row.operationId,splitChildId:request.childStockId};
}
async function finishCount(stockId:string){
  const panel=()=>document.querySelector<HTMLElement>('[aria-label="Физические пересчёты"]')!;assert(panel(),'Native count panel missing');await click('Загрузить пересчёты',panel());await fill('Основание пересчёта / коррекции','Native anytime operator physical count',true,panel());await fill('Свидетельство пересчёта / коррекции','NATIVE-PHYSICAL-COUNT-42',true,panel());
  await click('Начать пересчёт — сохранить предложение',panel());await until(async()=>(await inventoryCountProposals(scope(),fixture.operator)).some(r=>r.fields.kind==='open'),'native frozen count opening');const opening=(await inventoryCountProposals(scope(),fixture.operator)).find(r=>r.fields.kind==='open')!,countId=JSON.parse(opening.fields.request).countId;
  async function send(row: {key:string;operationId?:string}){await click('Подтвердить пересчёт '+row.operationId!.slice(0,8),panel());await until(async()=>(await inventoryOutbox.receivingDrafts.get(row.key))?.fields.state==='accepted','native count accepted');await until(()=>button('Загрузить пересчёты',panel()),'native count refresh completed');}
  await send(opening);await fill('Сессия пересчёта',countId,true,panel());await fill('Контейнер пересчёта',stockId,false,panel());await fill('Фактически посчитано','124000',true,panel());offline=true;await click('Сохранить наблюдение без изменения остатка',panel());await until(async()=>(await inventoryCountProposals(scope(),fixture.operator)).some(r=>r.fields.kind==='observe'),'native offline observation');const observation=(await inventoryCountProposals(scope(),fixture.operator)).find(r=>r.fields.kind==='observe')!;
  assert((await confirmedInventoryForScope(scope())).find(s=>s.stockId===stockId)?.onHand===125000,'Native count observation changed stock');offline=false;loseCountAck=true;await click('Подтвердить пересчёт '+observation.operationId!.slice(0,8),panel());await until(()=>panel().querySelector('[role="alert"]'),'native lost observation ACK');await send(observation);await refresh();assert((await confirmedInventoryForScope(scope())).find(s=>s.stockId===stockId)?.onHand===125000,'Accepted observation adjusted stock');
  assert(![...panel().querySelectorAll('button')].some(b=>b.textContent?.startsWith('Проверить коррекцию по наблюдению')),'Operator exposed count correction');
  const countHistory=await loadInventoryCountEvents(connection.session,scope(),await preflightInventoryStream(connection.session,scope()),countId);assert(countHistory.items.map(e=>e.kind).join(',')==='open,observe'&&!countHistory.closed,'Native unapproved count snapshot is wrong');
  const forbidden={operationId:crypto.randomUUID(),countId,deviceId:connection.selectedDeviceId,kind:'correct',observationId:observation.operationId,expectedRevision:1,reason:'Native forbidden operator correction',evidence:'Must fail'},epoch=await preflightInventoryStream(connection.session,scope());const denied=await originalFetch(fixture.serverUrl+'/inventory/counts/operations',{method:'POST',headers:{authorization:'Bearer '+connection.session.accessToken,'content-type':'application/json','x-device-proof':connection.session.deviceProofToken!,'x-inventory-epoch':epoch},body:JSON.stringify(forbidden)});assert(denied.status===403,'Operator self-approved count correction');
  await select('chief');await refresh();await click('Загрузить пересчёты',panel());await fill('Сессия пересчёта',countId,true,panel());await fill('Основание пересчёта / коррекции','Native Chief reviewed counted discrepancy',true,panel());await fill('Свидетельство пересчёта / коррекции','NATIVE-PHYSICAL-COUNT-42',true,panel());await click('Наблюдения и решения пересчёта',panel());await click('Проверить коррекцию по наблюдению '+observation.operationId!.slice(0,8),panel());await until(async()=>(await inventoryCountProposals(scope(),fixture.chief)).some(r=>r.fields.kind==='correct'),'native frozen correction approval');const correction=(await inventoryCountProposals(scope(),fixture.chief)).find(r=>r.fields.kind==='correct')!;
  loseCountAck=true;await click('Подтвердить пересчёт '+correction.operationId!.slice(0,8),panel());await until(()=>panel().querySelector('[role="alert"]'),'native lost correction ACK');await send(correction);await select('operator');await refresh();assert((await confirmedInventoryForScope(scope())).find(s=>s.stockId===stockId)?.onHand===124000,'Native approved count correction did not converge');
  await click('Загрузить пересчёты',panel());await fill('Сессия пересчёта',countId,true,panel());await click('Завершить пересчёт — сохранить предложение',panel());await until(async()=>(await inventoryCountProposals(scope(),fixture.operator)).some(r=>r.fields.kind==='close'),'native frozen count closure');await send((await inventoryCountProposals(scope(),fixture.operator)).find(r=>r.fields.kind==='close')!);assert(document.documentElement.scrollWidth<=innerWidth,'Native count screen overflow');
  const frozen=await loadInventoryCountEvents(connection.session,scope(),countHistory.epoch,countId,0,100,countHistory.throughSequence);assert(!frozen.closed&&frozen.items.map(e=>e.kind).join(',')==='open,observe','Native later approval/closure changed frozen count history');assert(button('Скачать полный срез пересчёта CSV',panel()),'Native complete count export control absent');
  return{nativeCountHistorySnapshot:true,countObservedWithoutStock:true,countOperatorCorrectionDenied:true,countChiefCorrection:true,countLostAckRetried:true,countId,countObservationOperationId:observation.operationId,countCorrectionOperationId:correction.operationId,countedQuantity:124000,countCorrectionQuantity:1000};
}
async function finishIdentification(stockId:string){
  const panel=document.querySelector<HTMLElement>('[aria-label="Идентификация склада"]');assert(panel,'Native identity panel missing');
  async function find(kind:'container'|'location'|'batch',id:string,cached=false){await fill('Тип ручного кода',kind,true,panel!);await fill('Код QR / штрихкода или UUID',id,true,panel!);await click(cached?'Найти в сохранённой области':'Найти на сервере',panel!);await until(()=>panel!.querySelector('[aria-label="Найденный складской объект"]')?.textContent?.includes(id),'native exact identity lookup');}
  for(const[kind,id]of[['container',stockId],['location',fixture.locationId],['batch',fixture.batchId]]as const)await find(kind,id);
  offline=true;for(const[kind,id]of[['container',stockId],['location',fixture.locationId],['batch',fixture.batchId]]as const)await find(kind,id,true);offline=false;
  const wrong=inventoryLabel(crypto.randomUUID(),'container',stockId);await fill('Код QR / штрихкода или UUID',wrong,false,panel!);await click('Найти на сервере',panel!);await until(()=>panel!.querySelector('[role="alert"]'),'native wrong-tenant scan denial');
  let media:MediaStream|undefined;try{media=await navigator.mediaDevices.getUserMedia({audio:false,video:{facingMode:'environment'}});assert(media.getVideoTracks().length===1&&media.getVideoTracks()[0].readyState==='live','Native camera did not open a real video track');}finally{media?.getTracks().forEach(t=>t.stop());}assert(media?.getTracks().every(t=>t.readyState==='ended'),'Native camera track not released');assert(document.documentElement.scrollWidth<=innerWidth,'Native identification overflow');
  return{nativeIdentityLookups:true,nativeOfflineIdentity:true,nativeWrongTenantLabelDenied:true,nativeCameraStreamStopped:true};
}
async function printLabel(stockId:string){
  await select('operator');await refresh();const card=document.getElementById('inventory-container-'+stockId);assert(card,'Native label source unavailable');const summary=[...card!.querySelectorAll('summary')].find(s=>s.textContent==='QR / ручной код контейнера');assert(summary,'Native label controls unavailable');(summary!.parentElement as HTMLDetailsElement).open=true;await click('Открыть печать этикетки',summary!.parentElement!);return{requested:true};
}
async function conceal(){await useAuthStore.getState().logout();await until(()=>!document.body.textContent?.includes('На руках:'),'native print return logout');return{concealed:true};}
(window as unknown as { storageCi: unknown }).storageCi = { connect, prepare, finish, printLabel, conceal };
