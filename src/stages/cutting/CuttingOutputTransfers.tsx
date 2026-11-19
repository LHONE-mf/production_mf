import { toInventoryBaseUnits } from "../../core/sync/inventoryReceiving";
import {saveReceivedCuttingSource} from "../../core/manufacturing/sortingCustody";
import React, { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  inventoryOutbox,
  inventoryScopeKey,
  type ReceivingDraft,
} from "../../core/sync/inventoryOutbox";
import {
  loadCutOutputLots,
  loadCutOutputHandoffs,
  loadCutOutputRecipients,
  loadCutOutputEvents,
  copyCutOutputLot,
  copyCutOutputHandoffRead,
  freezeCutOutputCommand,
  type CutOutputLot,
  type CutOutputHandoffRead,
  type CutOutputReceipt,
  type CutOutputCommand,
} from "../../core/sync/cuttingOutputs";
import type { CustodyPage } from "../../core/sync/roomCustody";
import { saveReceivingDraft } from "../../core/sync/inventoryReceiving";
import {
  useOutputDraft,
  outputButton as button,
  outputControl as control,
} from "../_common/useOutputDraft";
import {
  observedPieceCount,
  rollFrame,
  type CuttingOutputProps,
} from "./cuttingOutputForms";
export function CuttingOutputTransfers(
  props: CuttingOutputProps & {
    room: "cutting" | "sorting";
    refreshToken: number;
  },
) {
  const { scope, session, localActorId, room } = props,
    key = inventoryScopeKey(scope),
    forms =
      useLiveQuery(
        () =>
          inventoryOutbox.receivingDrafts
            .filter((r) => {
              try {
                const k = JSON.parse(r.key);
                return (
                  k[0] === key &&
                  k[1] === localActorId &&
                  k[2] === "cut-output-custody-form" &&
                  r.fields.room === room
                );
              } catch {
                return false;
              }
            })
            .toArray(),
        [key, localActorId, room],
      ) ?? [];
  const [shapes,setShapes]=useState<Record<string,''|'strip'|'prismatic'>>({});
  const [intakeMessage,setIntakeMessage]=useState('');
  const [lots, setLots] = useState<CustodyPage<CutOutputLot>>(),
    [handoffs, setHandoffs] = useState<CustodyPage<CutOutputHandoffRead>>(),
    [history, setHistory] = useState<{
      id: string;
      page: CustodyPage<CutOutputReceipt>;
    }>(),
    [formKey, setFormKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    running = useRef(false);
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
    setError("");
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
    const h = await loadCutOutputHandoffs(session, scope, room),
      l =
        room === "cutting"
          ? await loadCutOutputLots(session, scope)
          : undefined;
    if (l && h.epoch !== l.epoch) throw Error("История изменилась");
    if (alive.current) {
      setHandoffs(h);
      setLots(l);
    }
  }
  useEffect(() => {
    void work(refresh);
  }, [props.refreshToken]);
  async function form(fields: Record<string, string>) {
    const operationId = crypto.randomUUID(),
      draftKey = JSON.stringify([
        key,
        localActorId,
        "cut-output-custody-form",
        operationId,
      ]);
    await saveReceivingDraft(draftKey, 0, { operationId, room, ...fields });
    if (alive.current) setFormKey(draftKey);
  }
  const current = forms.find((r) => r.key === formKey);
  return (
    <section className="min-w-0 space-y-3">
      <h4>
        {room === "cutting"
          ? "Передача несортированных электродов в Sorting"
          : "Электроды, предложенные Sorting"}
      </h4>
      <button
        className={button}
        disabled={busy}
        onClick={() => void work(refresh)}
      >
        Обновить передачи электродов
      </button>
      {lots?.items.map((l) => (
        <article key={l.id} className={rollFrame}>
          <p>
            {l.snapshot.lot.label} · {l.materialCode} · {l.batchCode} ·{" "}
            {l.snapshot.quantity} шт
          </p>
          <p>
            Доступно для передачи {l.remaining}; зарезервировано {l.reserved};
            принято {l.received}.{" "}
            {l.eligible
              ? "Передача доступна"
              : "Лот / исходный материал удержан"}
            . Качество не подтверждено, материальный баланс не сверен.
          </p>
          <button
            className={button}
            disabled={busy || !l.eligible || l.remaining < 1}
            onClick={() =>
              void work(async () => {
                if (!lots) throw Error("Обновите лоты");
                const r = await loadCutOutputRecipients(session, scope, l.id);
                if (r.epoch !== lots.epoch) throw Error("История изменилась");
                await form({
                  kind: "offer",
                  epoch: lots.epoch,
                  lot: JSON.stringify(l),
                  recipients: JSON.stringify(r.items),
                  after: r.nextAfter ?? "",
                  destinationStepNumber: String(r.destinationStepNumber),
                  recipientWorkshopId: r.recipientWorkshopId,
                  recipientId: "",
                  quantity: "",
                  reason: "",
                  evidence: "",
                });
              })
            }
          >
            Подготовить передачу {l.snapshot.lot.label}
          </button>
          <details>
            <summary className="min-h-11 py-2">
              Выпуск и общий набор исходных измерений
            </summary>
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(l.snapshot, null, 2)}
            </pre>
          </details>
        </article>
      ))}
      {lots?.nextAfter && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const l = await loadCutOutputLots(
                session,
                scope,
                lots.nextAfter!,
              );
              if (l.epoch !== lots.epoch) throw Error("История изменилась");
              if (alive.current)
                setLots({ ...l, items: [...lots.items, ...l.items] });
            })
          }
        >
          Следующие выпущенные лоты
        </button>
      )}
      {intakeMessage&&<p role="status" className="text-emerald-200 text-sm">{intakeMessage}</p>}
      {handoffs?.items.map((h) => (
        <article key={h.operationId} className={rollFrame}>
          <p>
            Передача {h.operationId} · {h.handoff.sourceSnapshot.lot.label} ·{" "}
            {h.handoff.quantity} шт
          </p>
          <p>
            {h.received
              ? "Назначенный получатель подтвердил получение"
              : h.eventCount
                ? "Есть записи проверки; получение ещё не подтверждено"
                : "Ожидает назначенного получателя"}{" "}
            ·{" "}
            {h.eligible ? "источники доступны" : "источник / операция удержаны"}
          </p>
          <p>
            Предложено {h.handoff.quantity} шт. Приёмка подтверждает только
            подсчитанную часть исходного лота, без качества и без автоматической
            сортировки.
          </p>
          {room === "sorting" &&
            !h.received &&
            h.handoff.recipientId === scope.actorId && (
              <>
                <button
                  className={button}
                  disabled={busy || !h.eligible}
                  onClick={() =>
                    void work(() =>
                      form({
                        kind: "receipt",
                        receiptKind: "receive",
                        epoch: handoffs.epoch,
                        handoff: JSON.stringify(h),
                        observedQuantity: "",
                        observedLotLabel: "",

                        measurementNote: "",
                        reason: "",
                        evidence: "",
                      }),
                    )
                  }
                >
                  Подготовить получение {h.handoff.sourceSnapshot.lot.label}
                </button>
                <button
                  className={button}
                  disabled={busy}
                  onClick={() =>
                    void work(() =>
                      form({
                        kind: "receipt",
                        receiptKind: "discrepancy",
                        epoch: handoffs.epoch,
                        handoff: JSON.stringify(h),
                        observedQuantity: "",
                        observedLotLabel: "",

                        measurementNote: "",
                        reason: "",
                        evidence: "",
                      }),
                    )
                  }
                >
                  Сообщить о несоответствии {h.handoff.sourceSnapshot.lot.label}
                </button>
              </>
            )}
          {room==='sorting' && h.received && h.handoff.recipientId===scope.actorId && (
            <div className="mt-3 rounded-lg border border-blue-700/60 p-3 space-y-2">
              <p className="text-sm">Привязать подтверждённую приёмку ({h.received.observedQuantity} шт) к локальному контролю Visual → Thickness → Mass.</p>
              <label className="block text-sm">Форма электрода (установите по технологической карте)
                <select aria-label={"Форма электрода для приёмки "+h.operationId} className="mt-1 block min-h-11 w-full rounded border border-slate-600 bg-slate-900 text-white p-2"
                  value={shapes[h.operationId]??''} disabled={busy}
                  onChange={e=>setShapes(old=>({...old,[h.operationId]:e.target.value as ''|'strip'|'prismatic'}))}>
                  <option value="">— не выбрана —</option>
                  <option value="strip">Полоса (цилиндрический формат)</option>
                  <option value="prismatic">Пластина (призматический формат)</option>
                </select>
              </label>
              <button className={button} disabled={busy||!h.eligible||!shapes[h.operationId]}
                onClick={()=>void work(async()=>{
                  const source=await saveReceivedCuttingSource(h,scope,localActorId,shapes[h.operationId] as 'strip'|'prismatic');
                  if(alive.current)setIntakeMessage('Источник '+source.id+' сохранён. Откройте вкладку «Сортировка», создайте КД для этой партии и запишите три станции. Складское движение и QA не созданы.');
                })}>
                Сохранить источник для трёхстанционного контроля
              </button>
              {!h.eligible&&<p className="text-amber-200 text-xs">Источник удержан на сервере; новый контроль пока не начинайте.</p>}
              <p className="text-xs text-slate-400">Исходная приёмка и количество сохраняются без замены. Брак до сортировки неизвестен, не равен нулю.</p>
            </div>
          )}
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void work(async () => {
                const page = await loadCutOutputEvents(
                  session,
                  scope,
                  h.operationId,
                );
                if (page.epoch !== handoffs.epoch)
                  throw Error("История изменилась");
                if (alive.current) setHistory({ id: h.operationId, page });
              })
            }
          >
            История проверок {h.handoff.sourceSnapshot.lot.label}
          </button>
        </article>
      ))}
      {handoffs?.nextAfter && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const h = await loadCutOutputHandoffs(
                session,
                scope,
                room,
                handoffs.nextAfter!,
              );
              if (h.epoch !== handoffs.epoch) throw Error("История изменилась");
              if (alive.current)
                setHandoffs({ ...h, items: [...handoffs.items, ...h.items] });
            })
          }
        >
          Следующие передачи электродов
        </button>
      )}
      {history && (
        <details open className={rollFrame}>
          <summary className="min-h-11 py-2">
            История передачи {history.id}
          </summary>
          {history.page.items.map((e) => (
            <div key={e.operationId}>
              <p>
                {e.kind === "receive" ? "Получение" : "Несоответствие"} ·{" "}
                {e.recordedAt} · фактическое количество{" "}
                {e.observedQuantity === null
                  ? "не измерено"
                  : e.observedQuantity}{" "}
                · маркировка {e.observedLotLabel ?? "не установлена"}
              </p>
              <p>
                {e.measurementNote} · {e.reason} · {e.evidence}
              </p>
            </div>
          ))}
          {history.page.nextAfter && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  const p = await loadCutOutputEvents(
                    session,
                    scope,
                    history.id,
                    history.page.nextAfter!,
                  );
                  if (p.epoch !== history.page.epoch)
                    throw Error("История изменилась");
                  if (alive.current)
                    setHistory({
                      id: history.id,
                      page: {
                        ...p,
                        items: [...history.page.items, ...p.items],
                      },
                    });
                })
              }
            >
              Следующие записи проверки
            </button>
          )}
        </details>
      )}
      <fieldset disabled={busy} className="min-w-0 space-y-2">
        <label className="block">
          Сохранённая форма передачи лота
          <select
            aria-label="Сохранённая форма передачи лота"
            className={control}
            value={formKey}
            onChange={(e) => setFormKey(e.target.value)}
          >
            <option value="">Выберите форму</option>
            {forms.map((r) => (
              <option key={r.key} value={r.key}>
                {r.fields.kind === "offer"
                  ? "Передача"
                  : r.fields.receiptKind === "receive"
                    ? "Получение"
                    : "Несоответствие"}{" "}
                · {r.fields.operationId?.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {current && (
          <CustodyForm key={current.key} {...props} initial={current} />
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function CustodyForm({
  initial,
  ...props
}: CuttingOutputProps & { initial: ReceivingDraft }) {
  const { scope, session, localActorId } = props,
    draft = useOutputDraft(initial.key, initial.fields),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    [error, setError] = useState(""),
    running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const f = draft.row?.fields;
  if (!f) return <p>Восстановление формы передачи…</p>;
  let lot: CutOutputLot | undefined,
    handoff: CutOutputHandoffRead | undefined,
    recipients: { id: string; name: string }[] = [];
  try {
    if (f.kind === "offer") {
      lot = copyCutOutputLot(JSON.parse(f.lot));
      recipients = JSON.parse(f.recipients);
      if (!Array.isArray(recipients)) throw Error("Invalid choices");
    } else if (f.kind === "receipt")
      handoff = copyCutOutputHandoffRead(JSON.parse(f.handoff));
    else throw Error("Invalid form");
  } catch {
    return (
      <p role="alert">
        Повреждённая форма сохранена для сверки. Исходные данные не заменены.
      </p>
    );
  }
  const edit = (field: string, value: string) =>
    draft.edit({ ...f, [field]: value });
  async function freeze() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const row = await draft.flush(),
        fields = row.fields;
      let command: CutOutputCommand;
      if (fields.kind === "offer") {
        const l = copyCutOutputLot(JSON.parse(fields.lot)),
          r = (
            JSON.parse(fields.recipients) as { id: string; name: string }[]
          ).find((r) => r.id === fields.recipientId);
        if (!r) throw Error("Выберите назначенного получателя Sorting");
        command = {
          kind: "offer",
          request: {
            operationId: fields.operationId,
            deviceId: scope.deviceId,
            outputLotId: l.id,
            quantity: toInventoryBaseUnits(fields.quantity, "pieces", "pieces"),
            unit: "pieces",
            expectedSourceRevision: l.revision,
            recipientId: r.id,
            destinationStepNumber: Number(fields.destinationStepNumber),
            reason: fields.reason.trim(),
            evidence: fields.evidence.trim(),
          },
          base: {
            lot: l,
            recipient: r,
            destinationStepNumber: Number(fields.destinationStepNumber),
            recipientWorkshopId: fields.recipientWorkshopId,
          },
        };
      } else {
        if (!["receive", "discrepancy"].includes(fields.receiptKind))
          throw Error("Неизвестный вид проверки");
        const h = copyCutOutputHandoffRead(JSON.parse(fields.handoff)),
          quantity = observedPieceCount(fields.observedQuantity);
        if (fields.receiptKind === "receive" && quantity !== h.handoff.quantity)
          throw Error(
            "Подтвердите фактически полученное количество по предложению. Несовпадение сохраните отдельно.",
          );
        command = {
          kind: "receipt",
          request: {
            operationId: fields.operationId,
            deviceId: scope.deviceId,
            handoffId: h.operationId,
            kind: fields.receiptKind as "receive" | "discrepancy",
            observedQuantity: quantity,
            observedLotLabel: fields.observedLotLabel.trim() || null,
            unit: "pieces",
            measurementNote: fields.measurementNote.trim(),
            reason: fields.reason.trim(),
            evidence: fields.evidence.trim(),
          },
          base: { handoff: h },
        };
      }
      await freezeCutOutputCommand(scope, localActorId, fields.epoch, command);
      if (alive.current) setSaved(true);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const input = (field: string, label: string, required = true) => (
    <label className="block">
      {label}
      <input
        aria-label={label}
        required={required}
        maxLength={2000}
        className={control}
        value={f[field]}
        onChange={(e) => edit(field, e.target.value)}
      />
    </label>
  );
  return (
    <form
      aria-label="Проверка передачи лота"
      className={rollFrame}
      onSubmit={(e) => {
        e.preventDefault();
        void freeze();
      }}
    >
      <fieldset disabled={busy || saved} className="min-w-0 space-y-2">
        <legend>
          {lot
            ? "Передача подсчитанной части лота"
            : f.receiptKind === "receive"
              ? "Фактическое получение"
              : "Сообщение о несоответствии"}
        </legend>
        {lot ? (
          <>
            <p>
              {lot.snapshot.lot.label} · доступно {lot.remaining} шт. Передаётся
              явно подсчитанная часть лота; приёмка подтверждается отдельно.
            </p>
            {input("quantity", "Количество к передаче, шт")}
            <label className="block">
              Получатель электродов Sorting
              <select
                aria-label="Получатель электродов Sorting"
                required
                className={control}
                value={f.recipientId}
                onChange={(e) => edit("recipientId", e.target.value)}
              >
                <option value="">Выберите сотрудника получающего цеха</option>
                {recipients.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {r.id}
                  </option>
                ))}
              </select>
            </label>
            {f.after && (
              <button
                type="button"
                className={button}
                onClick={() => {
                  if (running.current) return;
                  running.current = true;
                  setBusy(true);
                  void loadCutOutputRecipients(session, scope, lot!.id, f.after)
                    .then((p) => {
                      if (
                        p.epoch !== f.epoch ||
                        p.destinationStepNumber !==
                          Number(f.destinationStepNumber) ||
                        p.recipientWorkshopId !== f.recipientWorkshopId
                      )
                        throw Error("Маршрут или история изменились");
                      draft.edit({
                        ...f,
                        recipients: JSON.stringify([...recipients, ...p.items]),
                        after: p.nextAfter ?? "",
                      });
                    })
                    .catch((e) => setError(String(e)))
                    .finally(() => {
                      running.current = false;
                      setBusy(false);
                    });
                }}
              >
                Следующие получатели электродов
              </button>
            )}
          </>
        ) : (
          <>
            <p>
              Ожидается {handoff?.handoff.sourceSnapshot.lot.label} ·{" "}
              {handoff?.handoff.quantity} шт. Получение подтверждает назначенный
              сотрудник после фактического подсчёта и проверки маркировки.
            </p>
            {input(
              "observedQuantity",
              "Фактически получено электродов, шт",
              f.receiptKind === "receive",
            )}
            {input(
              "observedLotLabel",
              "Маркировка полученного исходного лота",
              f.receiptKind === "receive",
            )}
            {input(
              "measurementNote",
              "Как проверены количество и исходный лот",
            )}
            <p>
              Пустое количество в сообщении о несоответствии означает «не
              установлено»; фактически посчитанный ноль укажите явно. Приёмка не
              подтверждает качество и не создаёт партии или результаты станций
              Sorting.
            </p>
          </>
        )}
        {input("reason", "Основание действия с лотом")}
        {input("evidence", "Свидетельство действия с лотом")}
        <button className={button}>
          Сохранить действие с лотом без отправки
        </button>
      </fieldset>
      {saved && (
        <p role="status">
          Исходное действие с лотом сохранено. Отправьте его отдельно ниже.
        </p>
      )}
      {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
    </form>
  );
}
