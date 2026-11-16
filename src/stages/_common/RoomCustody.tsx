import React, {useEffect, useRef, useState} from 'react';
import {useLiveQuery} from 'dexie-react-hooks';
import {useAuthStore} from '../../core/store/authStore';
import {useServerConnection} from '../../core/sync/serverConnection';
import type {HybridSession} from '../../core/sync/hybridClient';
import {
  inventoryOutbox,
  inventoryScopeKey,
  type InventoryScope,
  type ReceivingDraft,
} from '../../core/sync/inventoryOutbox';
import {saveReceivingDraft} from '../../core/sync/inventoryReceiving';
import {
  freezeRoomCustody,
  sendRoomCustody,
  measuredMg,
  roomCustodyProposals,
  loadSlurryOutputSources,
  loadSlurryOutputs,
  loadCustodyMaterials,
  loadCustodyRecipients,
  loadRoomHandoffs,
  loadHandoffEvents,
  type CustodyPage,
} from '../../core/sync/roomCustody';
import type {
  SlurryOutputSource,
  SlurryOutputLot,
  RoomHandoffRead,
  RoomReceipt,
  CustodyBase,
  CustodyCommand,
  CustodyRequest,
  CustodyMaterial,
  CustodyRecipient,
} from '../../core/sync/roomCustodyTypes';
import {useOutputDraft, outputButton as button, outputControl as control} from './useOutputDraft';
type Room = 'slurry' | 'coating';
interface Props {
  session: HybridSession;
  scope: InventoryScope;
  localActorId: string;
  room: Room;
}
const frame = 'min-w-0 space-y-2 rounded border border-slate-600 p-3';
const status = {
  pending: 'Ожидает отправки / исходного повтора; ответ может быть неизвестен',
  accepted: 'Сервер подтвердил событие',
  conflict: 'Конфликт — исходные данные удержаны',
  rejected: 'Отклонено — требуется сверка',
};
const commandLabel = {
  declaration: 'Выпуск Slurry',
  handoff: 'Передача в Coating',
  receipt: 'Наблюдение получателя',
};
const handoffStatus = {
  awaiting_receiver: 'Ожидает получателя',
  discrepancy: 'Расхождение — приёмка не подтверждена',
  received: 'Получено в Coating',
};
export function RoomCustody({room}: {room: Room}) {
  const connection = useServerConnection(),
    user = useAuthStore((s) => s.currentUser);
  const scope = connection
    ? {
        serverUrl: connection.serverUrl,
        organizationId: connection.organizationId,
        actorId: connection.serverActorId,
        deviceId: connection.selectedDeviceId,
      }
    : null;
  return (
    <section className="min-w-0 space-y-3 break-words rounded bg-slate-800 p-3">
      <h3>{room === 'slurry' ? 'Фактический выпуск и передача Slurry' : 'Подтверждённая приёмка Slurry'}</h3>
      <p>
        Физическая передача между комнатами требует отдельного подтверждения получателя. Складской остаток не
        меняется. Качество выпуска ещё не проверено; выпуск и приёмка не означают QA-разрешение.
      </p>
      {connection && scope && user ? (
        <RoomCustodyPanel
          key={inventoryScopeKey(scope) + user.id + connection.session.deviceProofExpiresAt}
          {...{room, scope, localActorId: user.id, session: connection.session}}
        />
      ) : (
        <p>
          Подключите сервер и подтвердите устройство в разделе «Синхронизация». Сохранённые предложения
          остаются в исходной области. Локальные замесы и расчёты доступны офлайн.
        </p>
      )}
    </section>
  );
}
export function RoomCustodyPanel({session, scope, localActorId, room}: Props) {
  const scopeKey = inventoryScopeKey(scope),
    proposals = useLiveQuery(() => roomCustodyProposals(scope, localActorId), [scopeKey, localActorId]) ?? [];
  const forms =
    useLiveQuery(
      () =>
        inventoryOutbox.receivingDrafts
          .filter((r) => {
            try {
              const k = JSON.parse(r.key);
              return (
                k[0] === scopeKey &&
                k[1] === localActorId &&
                k[2] === 'room-custody-form' &&
                (room === 'coating' ? r.fields.command === 'receipt' : r.fields.command !== 'receipt')
              );
            } catch {
              return false;
            }
          })
          .toArray(),
      [scopeKey, localActorId, room],
    ) ?? [];
  const [sources, setSources] = useState<CustodyPage<SlurryOutputSource>>(),
    [lots, setLots] = useState<CustodyPage<SlurryOutputLot>>(),
    [handoffs, setHandoffs] = useState<CustodyPage<RoomHandoffRead>>(),
    [sourceId, setSourceId] = useState(''),
    [lotId, setLotId] = useState(''),
    [selectedForm, setSelectedForm] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function work(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  async function refresh() {
    const nextHandoffs = await loadRoomHandoffs(session, scope, room);
    if (room === 'slurry') {
      const [nextSources, nextLots] = await Promise.all([
        loadSlurryOutputSources(session, scope),
        loadSlurryOutputs(session, scope),
      ]);
      if (nextSources.epoch !== nextHandoffs.epoch || nextLots.epoch !== nextHandoffs.epoch)
        throw Error('История изменилась; обновите данные');
      if (alive.current) {
        setSources(nextSources);
        setLots(nextLots);
      }
    }
    if (alive.current) setHandoffs(nextHandoffs);
  }
  async function form(
    command: CustodyCommand,
    base: CustodyBase,
    epoch: string,
    extra: Record<string, string> = {},
  ) {
    const operationId = crypto.randomUUID(),
      key = JSON.stringify([scopeKey, localActorId, 'room-custody-form', operationId]);
    await saveReceivingDraft(key, 0, {
      command,
      source: JSON.stringify(base),
      epoch,
      operationId,
      lines: JSON.stringify([{id: crypto.randomUUID(), materialId: '', grams: ''}]),
      scrap: '',
      loss: '',
      unknown: '',
      observedAt: '',
      specificationReference: '',
      grams: '',
      recipientId: '',
      kind: 'receive',
      notMeasured: 'false',
      reason: '',
      evidence: '',
      ...extra,
    });
    if (alive.current) setSelectedForm(key);
  }
  const chosenForm = forms.find((r) => r.key === selectedForm);
  return (
    <div className="min-w-0 space-y-3 break-words">
      <button className={button} disabled={busy} onClick={() => void work(refresh)}>
        Обновить движение {room === 'slurry' ? 'Slurry' : 'Coating'}
      </button>
      <p>
        Для загрузки и отправки нужно действующее подтверждение устройства. Загруженные формы можно заполнить
        и сохранить офлайн; отправка выполняется отдельно.
      </p>
      {room === 'slurry' && (
        <>
          <label>
            Подтверждённый расход для выпуска
            <select className={control} value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              <option value="">Выберите исходный замес</option>
              {sources?.items.map((s) => (
                <option
                  key={s.operationId}
                  value={s.operationId}
                  disabled={!s.eligible || s.declarationId !== null}
                >
                  {s.sourceSnapshot.consumption.source.batchCode} · вход {s.inputQuantity / 1000} г ·{' '}
                  {s.declarationId ? 'выпуск уже объявлен' : s.eligible ? 'доступен' : 'удержан'}
                </option>
              ))}
            </select>
          </label>
          {sources?.nextAfter && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  const n = await loadSlurryOutputSources(session, scope, sources.nextAfter!);
                  if (n.epoch !== sources.epoch) throw Error('История изменилась');
                  if (alive.current) setSources({...n, items: [...sources.items, ...n.items]});
                })
              }
            >
              Следующие исходные расходы
            </button>
          )}
          <button
            className={button}
            disabled={busy || !sourceId}
            onClick={() =>
              void work(async () => {
                const s = sources?.items.find((r) => r.operationId === sourceId);
                if (!s || !sources?.postingEnabled) throw Error('Исходный расход недоступен');
                const p = await loadCustodyMaterials(session, scope, s.operationId);
                if (p.epoch !== sources.epoch) throw Error('История изменилась');
                await form('declaration', s, sources.epoch, {
                  materials: JSON.stringify(p.items),
                  materialsAfter: p.nextAfter ?? '',
                });
              })
            }
          >
            Подготовить форму фактического выпуска
          </button>
          <h4>Измеренные выходные лоты</h4>
          {lots?.items.map((l) => (
            <article className={frame} key={l.id}>
              <p>
                {l.materialName} · {l.materialCode} · лот {l.id}
              </p>
              <p>
                Выпущено {l.quantity / 1000} г; доступно {l.available / 1000} г; в передаче{' '}
                {l.inTransit / 1000} г; принято {l.received / 1000} г.
              </p>
              <p>
                По замесу: брак {l.sourceSnapshot.declaration.scrapMg / 1000} г; измеренные потери{' '}
                {l.sourceSnapshot.declaration.measuredLossMg / 1000} г; неразнесено{' '}
                {l.sourceSnapshot.declaration.unknownMg / 1000} г.
              </p>
              <p>
                {l.eligible ? 'Источник доступен для передачи' : 'Источник удержан / операция недоступна'} ·
                качество не проверено
              </p>
              <Genealogy value={l.sourceSnapshot} />
            </article>
          ))}
          {lots?.nextAfter && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  const n = await loadSlurryOutputs(session, scope, lots.nextAfter!);
                  if (n.epoch !== lots.epoch) throw Error('История изменилась');
                  if (alive.current) setLots({...n, items: [...lots.items, ...n.items]});
                })
              }
            >
              Следующие выходные лоты
            </button>
          )}
          <label>
            Лот для передачи в Coating
            <select className={control} value={lotId} onChange={(e) => setLotId(e.target.value)}>
              <option value="">Выберите фактический выход</option>
              {lots?.items.map((l) => (
                <option key={l.id} value={l.id} disabled={!l.eligible || l.available === 0}>
                  {l.materialCode} · {l.available / 1000} г · {l.id}
                </option>
              ))}
            </select>
          </label>
          <button
            className={button}
            disabled={busy || !lotId}
            onClick={() =>
              void work(async () => {
                const l = lots?.items.find((r) => r.id === lotId);
                if (!l || !lots?.postingEnabled) throw Error('Лот недоступен');
                const p = await loadCustodyRecipients(session, scope, l.id);
                if (p.epoch !== lots.epoch) throw Error('История изменилась');
                await form('handoff', l, lots.epoch, {
                  recipients: JSON.stringify(p.items),
                  recipientsAfter: p.nextAfter ?? '',
                  destinationStepNumber: String(p.destinationStepNumber),
                  destinationWorkshopId: p.destinationWorkshopId,
                });
              })
            }
          >
            Подготовить передачу выбранного лота
          </button>
        </>
      )}
      <h4>Физические передачи</h4>
      {handoffs?.items.map((h) => (
        <article className={frame} key={h.operationId}>
          <p>
            {handoffStatus[h.status]} · {h.quantity / 1000} г · {h.operationId}
          </p>
          <p>
            Партия {h.productionBatchId} · шаг Coating {h.destinationStepNumber} · получатель {h.recipientId}
          </p>
          <p>
            Подтверждённая масса в Coating: {h.custodyQuantity / 1000} г.{' '}
            {h.eligible ? 'Исходные материалы не удержаны' : 'Источник удержан / операция недоступна'}
          </p>
          <Genealogy value={h.sourceSnapshot} />
          <HandoffHistory {...{session, scope, room, handoff: h}} />
          {room === 'coating' && h.status !== 'received' && h.recipientId === scope.actorId && (
            <button
              className={button}
              disabled={busy}
              onClick={() => void work(() => form('receipt', h, handoffs.epoch))}
            >
              Подготовить наблюдение приёмки {h.operationId.slice(0, 8)}
            </button>
          )}
        </article>
      ))}
      {handoffs?.nextAfter && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const n = await loadRoomHandoffs(session, scope, room, handoffs.nextAfter!);
              if (n.epoch !== handoffs.epoch) throw Error('История изменилась');
              if (alive.current) setHandoffs({...n, items: [...handoffs.items, ...n.items]});
            })
          }
        >
          Следующие передачи
        </button>
      )}
      <label>
        Сохранённая форма
        <select
          className={control}
          disabled={busy}
          value={selectedForm}
          onChange={(e) => setSelectedForm(e.target.value)}
        >
          <option value="">Выберите или подготовьте форму</option>
          {forms.map((r) => (
            <option key={r.key} value={r.key}>
              {commandLabel[r.fields.command as CustodyCommand]} · {r.fields.operationId.slice(0, 8)}
            </option>
          ))}
        </select>
      </label>
      {chosenForm && (
        <fieldset disabled={busy} className="min-w-0">
          <CustodyForm key={chosenForm.key} {...{session, scope, localActorId, initial: chosenForm}} />
        </fieldset>
      )}
      <h4>Исходные предложения</h4>
      {proposals
        .filter((r) => (room === 'coating' ? r.fields.command === 'receipt' : r.fields.command !== 'receipt'))
        .map((r) => (
          <article className={frame} key={r.key}>
            <p>
              {commandLabel[r.fields.command as CustodyCommand]} · {r.operationId} ·{' '}
              {status[r.fields.state as keyof typeof status]}
            </p>
            {r.fields.state === 'accepted' && r.fields.command === 'handoff' && (
              <p>Отправка записана. Получатель отдельно подтверждает физическое получение.</p>
            )}
            {r.fields.state === 'pending' && (
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    await sendRoomCustody(session, scope, localActorId, r.key);
                    await refresh();
                  })
                }
              >
                Отправить исходное событие {r.operationId?.slice(0, 8)}
              </button>
            )}
            <details>
              <summary className="min-h-11 py-2">Исходные количества, источник и ответ</summary>
              <pre className="whitespace-pre-wrap break-all">
                {r.fields.request}
                {'\n'}
                {r.fields.acknowledgement}
                {'\n'}
                {r.fields.error}
              </pre>
            </details>
          </article>
        ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
function Genealogy({value}: {value: unknown}) {
  return (
    <details>
      <summary className="min-h-11 py-2">Происхождение и исходные измерения</summary>
      <pre className="whitespace-pre-wrap break-all">{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}
function HandoffHistory({
  session,
  scope,
  room,
  handoff,
}: {
  session: HybridSession;
  scope: InventoryScope;
  room: Room;
  handoff: RoomHandoffRead;
}) {
  const [history, setHistory] = useState<CustodyPage<RoomReceipt>>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return (
    <details>
      <summary className="min-h-11 py-2">Наблюдения получателя ({handoff.eventCount})</summary>
      {(history?.items ?? handoff.events).map((e) => (
        <p key={e.operationId}>
          {e.kind === 'receive' ? 'Получено' : 'Расхождение'}:{' '}
          {e.observedQuantity === null ? 'не измерено' : e.observedQuantity / 1000 + ' г'} · {e.reason} ·{' '}
          {e.evidence} · {e.actorId} · {e.recordedAt}
        </p>
      ))}
      {(!history || history.nextAfter) && (
        <button
          className={button}
          disabled={busy}
          onClick={() => {
            if (running.current) return;
            running.current = true;
            setBusy(true);
            setError('');
            void (async () => {
              try {
                const p = await loadHandoffEvents(
                  session,
                  scope,
                  room,
                  handoff.operationId,
                  history?.nextAfter ?? undefined,
                );
                if (history && p.epoch !== history.epoch) throw Error('История изменилась');
                if (alive.current) setHistory({...p, items: [...(history?.items ?? []), ...p.items]});
              } catch (e) {
                if (alive.current) setError(String(e));
              } finally {
                running.current = false;
                if (alive.current) setBusy(false);
              }
            })();
          }}
        >
          Загрузить {history ? 'следующие' : 'полные'} наблюдения
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </details>
  );
}
interface OutputLine {
  id: string;
  materialId: string;
  grams: string;
}
function CustodyForm({
  session,
  scope,
  localActorId,
  initial,
}: {
  session: HybridSession;
  scope: InventoryScope;
  localActorId: string;
  initial: ReceivingDraft;
}) {
  const draft = useOutputDraft(initial.key, initial.fields),
    [error, setError] = useState(''),
    [saved, setSaved] = useState(false),
    [busy, setBusy] = useState(false),
    running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!draft.row) return <p>{draft.error || 'Читаем сохранённую форму…'}</p>;
  const fields = draft.row.fields,
    command = fields.command as CustodyCommand;
  let base: CustodyBase, lines: OutputLine[], materials: CustodyMaterial[], recipients: CustodyRecipient[];
  try {
    base = JSON.parse(fields.source);
    lines = JSON.parse(fields.lines);
    materials = JSON.parse(fields.materials ?? '[]');
    recipients = JSON.parse(fields.recipients ?? '[]');
  } catch {
    return <p role="alert">Исходная форма не распознана и сохранена для сверки.</p>;
  }
  function edit(patch: Record<string, string>) {
    draft.edit({...fields, ...patch});
    setSaved(false);
  }
  async function work(fn: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <form
      aria-label={commandLabel[command]}
      className={frame}
      onSubmit={(e) => {
        e.preventDefault();
        void work(async () => {
          const row = await draft.flush(),
            f = row.fields,
            source: CustodyBase = JSON.parse(f.source),
            common = {
              operationId: f.operationId,
              deviceId: scope.deviceId,
              reason: f.reason,
              evidence: f.evidence,
            };
          let request: CustodyRequest;
          if (command === 'declaration') {
            const selected: OutputLine[] = JSON.parse(f.lines),
              catalogue: CustodyMaterial[] = JSON.parse(f.materials);
            if (selected.some((l) => !catalogue.some((m) => m.id === l.materialId)))
              throw Error('Явно выберите складской материал выпуска по утверждённой спецификации');
            if (!f.observedAt.trim()) throw Error('Укажите время фактического взвешивания');
            request = {
              ...common,
              consumptionId: (source as SlurryOutputSource).operationId,
              outputs: selected.map((l) => ({
                id: l.id,
                materialId: l.materialId,
                quantity: measuredMg(l.grams),
              })),
              scrapMg: measuredMg(f.scrap, true),
              measuredLossMg: measuredMg(f.loss, true),
              unknownMg: measuredMg(f.unknown, true),
              basis: 'weighed-slurry-mass',
              specificationReference: f.specificationReference,
              observedAt: new Date(f.observedAt).getTime(),
            };
          } else if (command === 'handoff') {
            if (!(JSON.parse(f.recipients) as CustodyRecipient[]).some((r) => r.id === f.recipientId))
              throw Error('Выберите назначенного получателя Coating');
            request = {
              ...common,
              outputLotId: (source as SlurryOutputLot).id,
              quantity: measuredMg(f.grams),
              expectedSourceRevision: (source as SlurryOutputLot).revision,
              recipientId: f.recipientId,
              destinationStepNumber: Number(f.destinationStepNumber),
            };
          } else
            request = {
              ...common,
              handoffId: (source as RoomHandoffRead).operationId,
              ...(f.kind === 'receive'
                ? {kind: 'receive' as const, observedQuantity: measuredMg(f.grams)}
                : {
                    kind: 'discrepancy' as const,
                    observedQuantity: f.notMeasured === 'true' ? null : measuredMg(f.grams, true),
                  }),
            };
          await freezeRoomCustody(scope, localActorId, f.epoch, command, request, source);
          if (alive.current) setSaved(true);
        });
      }}
    >
      <h4>{commandLabel[command]} · исходный снимок сохранён</h4>
      <Genealogy value={base} />
      {command === 'declaration' && (
        <>
          <p>
            Полное завершение выбранного замеса: самостоятельно взвесьте каждый выход. Вход{' '}
            {(base as SlurryOutputSource).inputQuantity / 1000} г должен равняться выходам + браку +
            измеренным потерям + неразнесённой массе. Неразнесённая масса не считается годной или точно
            измеренной потерей. Для каждой категории явно внесите число, включая 0.
          </p>
          {lines.map((l, i) => (
            <fieldset className={frame} key={l.id}>
              <legend>Измеренный выход {i + 1}</legend>
              <label>
                Материал выхода {i + 1}
                <select
                  className={control}
                  value={l.materialId}
                  onChange={(e) =>
                    edit({
                      lines: JSON.stringify(
                        lines.map((x) => (x.id === l.id ? {...x, materialId: e.target.value} : x)),
                      ),
                    })
                  }
                >
                  <option value="">Выберите материал по спецификации</option>
                  {materials.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.code} · {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Фактическая масса выхода {i + 1}, г
                <input
                  className={control}
                  inputMode="decimal"
                  value={l.grams}
                  onChange={(e) =>
                    edit({
                      lines: JSON.stringify(
                        lines.map((x) => (x.id === l.id ? {...x, grams: e.target.value} : x)),
                      ),
                    })
                  }
                />
              </label>
              <button
                type="button"
                className={button}
                onClick={() => edit({lines: JSON.stringify(lines.filter((x) => x.id !== l.id))})}
              >
                Убрать выход {i + 1}
              </button>
            </fieldset>
          ))}
          <button
            type="button"
            className={button}
            disabled={lines.length >= 100}
            onClick={() =>
              edit({lines: JSON.stringify([...lines, {id: crypto.randomUUID(), materialId: '', grams: ''}])})
            }
          >
            Добавить измеренный выход
          </button>
          {fields.materialsAfter && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  const r = await draft.flush(),
                    p = await loadCustodyMaterials(
                      session,
                      scope,
                      (base as SlurryOutputSource).operationId,
                      r.fields.materialsAfter,
                    );
                  if (p.epoch !== r.fields.epoch) throw Error('История изменилась');
                  draft.edit({
                    ...r.fields,
                    materials: JSON.stringify([...JSON.parse(r.fields.materials), ...p.items]),
                    materialsAfter: p.nextAfter ?? '',
                  });
                })
              }
            >
              Следующие материалы выпуска
            </button>
          )}
          {(
            [
              ['scrap', 'Измеренный брак, г'],
              ['loss', 'Измеренные потери, г'],
              ['unknown', 'Неразнесённая масса, г'],
            ] as const
          ).map(([k, label]) => (
            <label className="block" key={k}>
              {label}
              <input
                className={control}
                inputMode="decimal"
                value={fields[k]}
                onChange={(e) => edit({[k]: e.target.value})}
              />
            </label>
          ))}
          <label className="block">
            Утверждённая спецификация выпуска
            <input
              className={control}
              value={fields.specificationReference}
              onChange={(e) => edit({specificationReference: e.target.value})}
            />
          </label>
          <label className="block">
            Время фактического взвешивания
            <input
              type="datetime-local"
              className={control}
              value={fields.observedAt}
              onChange={(e) => edit({observedAt: e.target.value})}
            />
          </label>
        </>
      )}
      {command === 'handoff' && (
        <>
          <p>
            Сохранённый доступный остаток {(base as SlurryOutputLot).available / 1000} г. Следующий шаг
            маршрута: Coating {fields.destinationStepNumber}, цех {fields.destinationWorkshopId}.
          </p>
          <label>
            Назначенный получатель Coating
            <select
              className={control}
              value={fields.recipientId}
              onChange={(e) => edit({recipientId: e.target.value})}
            >
              <option value="">Выберите получателя</option>
              {recipients.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} · {r.id}
                </option>
              ))}
            </select>
          </label>
          {fields.recipientsAfter && (
            <button
              type="button"
              className={button}
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  const r = await draft.flush(),
                    p = await loadCustodyRecipients(
                      session,
                      scope,
                      (base as SlurryOutputLot).id,
                      r.fields.recipientsAfter,
                    );
                  if (
                    p.epoch !== r.fields.epoch ||
                    String(p.destinationStepNumber) !== r.fields.destinationStepNumber ||
                    p.destinationWorkshopId !== r.fields.destinationWorkshopId
                  )
                    throw Error('Маршрут или история изменены');
                  draft.edit({
                    ...r.fields,
                    recipients: JSON.stringify([...JSON.parse(r.fields.recipients), ...p.items]),
                    recipientsAfter: p.nextAfter ?? '',
                  });
                })
              }
            >
              Следующие получатели
            </button>
          )}
          <label>
            Фактически передаваемая масса, г
            <input
              className={control}
              inputMode="decimal"
              value={fields.grams}
              onChange={(e) => edit({grams: e.target.value})}
            />
          </label>
        </>
      )}
      {command === 'receipt' && (
        <>
          <p>
            Предложено {(base as RoomHandoffRead).quantity / 1000} г. При расхождении сохраните наблюдение
            отдельно: масса остаётся удержанной до точного подтверждения и сверки. Подтверждение ещё не
            списывает Slurry на нанесение.
          </p>
          <label>
            Результат физической приёмки
            <select className={control} value={fields.kind} onChange={(e) => edit({kind: e.target.value})}>
              <option value="receive">Получено ровно предложенное количество</option>
              <option value="discrepancy">Расхождение / количество не измерено</option>
            </select>
          </label>
          <label>
            Фактически наблюдаемая масса, г
            <input
              className={control}
              inputMode="decimal"
              disabled={fields.kind === 'discrepancy' && fields.notMeasured === 'true'}
              value={fields.grams}
              onChange={(e) => edit({grams: e.target.value})}
            />
          </label>
          {fields.kind === 'discrepancy' && (
            <label className="flex min-h-11 items-center gap-2">
              <input
                type="checkbox"
                checked={fields.notMeasured === 'true'}
                onChange={(e) => edit({notMeasured: String(e.target.checked)})}
              />
              Количество не измерено (не равно 0)
            </label>
          )}
        </>
      )}
      <label className="block">
        Основание события
        <input className={control} value={fields.reason} onChange={(e) => edit({reason: e.target.value})} />
      </label>
      <label className="block">
        Свидетельство измерения и сверки
        <textarea
          className={control}
          value={fields.evidence}
          onChange={(e) => edit({evidence: e.target.value})}
        />
      </label>
      <button className={button} disabled={busy || !!draft.error}>
        Сохранить исходное событие без отправки
      </button>
      {saved && <p role="status">Исходное предложение сохранено. Отправка — отдельной кнопкой.</p>}
      {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
    </form>
  );
}
