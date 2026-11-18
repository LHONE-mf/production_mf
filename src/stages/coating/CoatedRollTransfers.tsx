import React, { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  inventoryOutbox,
  inventoryScopeKey,
  type ReceivingDraft,
} from "../../core/sync/inventoryOutbox";
import {
  loadCoatedRolls,
  loadRollHandoffs,
  loadRollRecipients,
  loadRollEvents,
  copyRollLot,
  copyRollHandoffRead,
  freezeRollCommand,
  type RollLot,
  type RollHandoffRead,
  type RollReceipt,
  type RollCommand,
} from "../../core/sync/coatedRolls";
import type { CustodyPage } from "../../core/sync/roomCustody";
import { saveReceivingDraft } from "../../core/sync/inventoryReceiving";
import {
  useOutputDraft,
  outputButton as button,
  outputControl as control,
} from "../_common/useOutputDraft";
import {
  optionalRollMeasure,
  observedRollCount,
  rollFrame,
  type CoatedRollProps,
} from "./coatedRollForms";
export function CoatedRollTransfers(
  props: CoatedRollProps & {
    room: "coating" | "calendaring";
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
                  k[2] === "coated-roll-custody-form" &&
                  r.fields.room === room
                );
              } catch {
                return false;
              }
            })
            .toArray(),
        [key, localActorId, room],
      ) ?? [];
  const [lots, setLots] = useState<CustodyPage<RollLot>>(),
    [handoffs, setHandoffs] = useState<CustodyPage<RollHandoffRead>>(),
    [history, setHistory] = useState<{
      id: string;
      page: CustodyPage<RollReceipt>;
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
    const h = await loadRollHandoffs(session, scope, room),
      l =
        room === "coating" ? await loadCoatedRolls(session, scope) : undefined;
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
        "coated-roll-custody-form",
        operationId,
      ]);
    await saveReceivingDraft(draftKey, 0, { operationId, room, ...fields });
    if (alive.current) setFormKey(draftKey);
  }
  const current = forms.find((r) => r.key === formKey);
  return (
    <section className="min-w-0 space-y-3">
      <h4>
        {room === "coating"
          ? "Передача физических рулонов в Calendaring"
          : "Рулоны, предложенные Calendaring"}
      </h4>
      <button
        className={button}
        disabled={busy}
        onClick={() => void work(refresh)}
      >
        Обновить передачи рулонов
      </button>
      {lots?.items.map((l) => (
        <article key={l.id} className={rollFrame}>
          <p>
            {l.snapshot.roll.label} · {l.materialCode} · {l.batchCode} · 1 рулон
          </p>
          <p>
            Измеренная длина {l.snapshot.roll.measuredLengthMm} мм ·{" "}
            {l.snapshot.roll.measuredMassMg === null
              ? "масса не измерена"
              : `масса ${l.snapshot.roll.measuredMassMg} мг`}
          </p>
          <p>
            Доступно для передачи {l.remaining}; зарезервировано {l.reserved};
            принято {l.received}.{" "}
            {l.eligible
              ? "Передача доступна"
              : "Рулон / исходный материал удержан"}
            . Качество не подтверждено, материальный баланс не сверен.
          </p>
          <button
            className={button}
            disabled={busy || !l.eligible || l.remaining !== 1}
            onClick={() =>
              void work(async () => {
                if (!lots) throw Error("Обновите рулоны");
                const r = await loadRollRecipients(session, scope, l.id);
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
                  reason: "",
                  evidence: "",
                });
              })
            }
          >
            Подготовить передачу {l.snapshot.roll.label}
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
              const l = await loadCoatedRolls(session, scope, lots.nextAfter!);
              if (l.epoch !== lots.epoch) throw Error("История изменилась");
              if (alive.current)
                setLots({ ...l, items: [...lots.items, ...l.items] });
            })
          }
        >
          Следующие выпущенные рулоны
        </button>
      )}
      {handoffs?.items.map((h) => (
        <article key={h.operationId} className={rollFrame}>
          <p>
            Передача {h.operationId} · {h.handoff.sourceSnapshot.roll.label} · 1
            рулон
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
            Получатель {h.handoff.recipientId} · длина по выпуску{" "}
            {h.handoff.sourceSnapshot.roll.measuredLengthMm} мм. Приёмка не
            подтверждает качество.
          </p>
          {room === "calendaring" &&
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
                        observedRollLabel: "",
                        observedLengthM: "",
                        measurementNote: "",
                        reason: "",
                        evidence: "",
                      }),
                    )
                  }
                >
                  Подготовить получение {h.handoff.sourceSnapshot.roll.label}
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
                        observedRollLabel: "",
                        observedLengthM: "",
                        measurementNote: "",
                        reason: "",
                        evidence: "",
                      }),
                    )
                  }
                >
                  Сообщить о несоответствии{" "}
                  {h.handoff.sourceSnapshot.roll.label}
                </button>
              </>
            )}
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void work(async () => {
                const page = await loadRollEvents(
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
            История проверок {h.handoff.sourceSnapshot.roll.label}
          </button>
        </article>
      ))}
      {handoffs?.nextAfter && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const h = await loadRollHandoffs(
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
          Следующие передачи рулонов
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
                · маркировка {e.observedRollLabel ?? "не установлена"}
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
                  const p = await loadRollEvents(
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
        <label>
          Сохранённая форма передачи рулона
          <select
            aria-label="Сохранённая форма передачи рулона"
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
}: CoatedRollProps & { initial: ReceivingDraft }) {
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
  let lot: RollLot | undefined,
    handoff: RollHandoffRead | undefined,
    recipients: { id: string; name: string }[] = [];
  try {
    if (f.kind === "offer") {
      lot = copyRollLot(JSON.parse(f.lot));
      recipients = JSON.parse(f.recipients);
      if (!Array.isArray(recipients)) throw Error("Invalid choices");
    } else if (f.kind === "receipt")
      handoff = copyRollHandoffRead(JSON.parse(f.handoff));
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
      let command: RollCommand;
      if (fields.kind === "offer") {
        const l = copyRollLot(JSON.parse(fields.lot)),
          r = (
            JSON.parse(fields.recipients) as { id: string; name: string }[]
          ).find((r) => r.id === fields.recipientId);
        if (!r) throw Error("Выберите назначенного получателя Calendaring");
        command = {
          kind: "offer",
          request: {
            operationId: fields.operationId,
            deviceId: scope.deviceId,
            outputLotId: l.id,
            quantity: 1,
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
        const h = copyRollHandoffRead(JSON.parse(fields.handoff)),
          quantity = observedRollCount(fields.observedQuantity);
        if (fields.receiptKind === "receive" && quantity !== 1)
          throw Error(
            "Подтвердите один фактически полученный рулон. Иное количество сохраните как несоответствие.",
          );
        command = {
          kind: "receipt",
          request: {
            operationId: fields.operationId,
            deviceId: scope.deviceId,
            handoffId: h.operationId,
            kind: fields.receiptKind as "receive" | "discrepancy",
            observedQuantity: quantity,
            observedRollLabel: fields.observedRollLabel.trim() || null,
            observedLengthMm: optionalRollMeasure(fields.observedLengthM, "m"),
            measurementNote: fields.measurementNote.trim(),
            reason: fields.reason.trim(),
            evidence: fields.evidence.trim(),
          },
          base: { handoff: h },
        };
      }
      await freezeRollCommand(scope, localActorId, fields.epoch, command);
      if (alive.current) setSaved(true);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const input = (field: string, label: string, required = true) => (
    <label>
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
      aria-label="Проверка передачи рулона"
      className={rollFrame}
      onSubmit={(e) => {
        e.preventDefault();
        void freeze();
      }}
    >
      <fieldset disabled={busy || saved} className="min-w-0 space-y-2">
        <legend>
          {lot
            ? "Отдельная передача одного физического рулона"
            : f.receiptKind === "receive"
              ? "Фактическое получение"
              : "Сообщение о несоответствии"}
        </legend>
        {lot ? (
          <>
            <p>
              {lot.snapshot.roll.label} · 1 рулон ·{" "}
              {lot.snapshot.roll.measuredLengthMm} мм по выпуску. Передаётся
              весь физический рулон; частичная длина требует отдельного
              подтверждённого разделения.
            </p>
            <label>
              Получатель рулона Calendaring
              <select
                aria-label="Получатель рулона Calendaring"
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
                  void loadRollRecipients(session, scope, lot!.id, f.after)
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
                Следующие получатели рулона
              </button>
            )}
          </>
        ) : (
          <>
            <p>
              Ожидается {handoff?.handoff.sourceSnapshot.roll.label} · 1
              физический рулон. Получение подтверждает назначенный сотрудник
              после фактического подсчёта и проверки маркировки.
            </p>
            {input(
              "observedQuantity",
              "Фактически получено рулонов",
              f.receiptKind === "receive",
            )}
            {input(
              "observedRollLabel",
              "Фактическая маркировка полученного рулона",
              f.receiptKind === "receive",
            )}
            {input(
              "observedLengthM",
              "Повторно измеренная длина рулона, м · пусто = не измерена",
              false,
            )}
            {input(
              "measurementNote",
              "Как проверены количество, маркировка и длина",
            )}
            <p>
              Пустое количество в сообщении о несоответствии означает «не
              установлено»; фактически посчитанный ноль укажите явно.
              Неизмеренная длина остаётся неизвестной.
            </p>
          </>
        )}
        {input("reason", "Основание действия с рулоном")}
        {input("evidence", "Свидетельство действия с рулоном")}
        <button className={button}>
          Сохранить действие с рулоном без отправки
        </button>
      </fieldset>
      {saved && (
        <p role="status">
          Исходное действие с рулоном сохранено. Отправьте его отдельно ниже.
        </p>
      )}
      {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
    </form>
  );
}
