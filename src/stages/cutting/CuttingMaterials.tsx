import React, { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAuthStore } from "../../core/store/authStore";
import { useServerConnection } from "../../core/sync/serverConnection";
import type { HybridSession } from "../../core/sync/hybridClient";
import {
  inventoryOutbox,
  inventoryScopeKey,
  type InventoryScope,
  type ReceivingDraft,
} from "../../core/sync/inventoryOutbox";
import { saveReceivingDraft } from "../../core/sync/inventoryReceiving";
import { type CustodyPage } from "../../core/sync/roomCustody";
import {
  measuredCuttingMm,
  loadCuttingRoll,
  loadCuttingConsumptions,
  freezeCuttingConsumption,
  sendCuttingConsumption,
  cuttingConsumptionProposals,
  type CuttingRollSource,
  type CuttingConsumptionRequest,
  type CuttingConsumption,
} from "../../core/sync/cuttingConsumption";
import {
  useOutputDraft,
  outputButton as button,
  outputControl as control,
} from "../_common/useOutputDraft";
const frame = "min-w-0 space-y-2 rounded border border-slate-600 p-3";
interface Props {
  session: HybridSession;
  scope: InventoryScope;
  localActorId: string;
}
export function CuttingMaterials() {
  const connection = useServerConnection(),
    user = useAuthStore((s) => s.currentUser),
    scope = connection
      ? {
          serverUrl: connection.serverUrl,
          organizationId: connection.organizationId,
          actorId: connection.serverActorId,
          deviceId: connection.selectedDeviceId,
        }
      : null;
  return (
    <section className="min-w-0 space-y-3 break-words rounded bg-slate-800 p-3">
      <h3>Принятые рулоны и фактический расход Cutting</h3>
      <p>
        Укажите независимо измеренную длину, фактически обработанную на
        каландре. Вместимость каждого принятого рулона берётся из его
        сохранённого измерения Calendaring; подтверждение одного рулона не означает
        один метр. Частичный расход сохраняет остаток длины. Масса, выход, брак
        и качество не вычисляются. Склад повторно не списывается.
      </p>
      {connection && scope && user ? (
        <CuttingMaterialsPanel
          key={
            inventoryScopeKey(scope) +
            user.id +
            connection.session.deviceProofExpiresAt
          }
          {...{ session: connection.session, scope, localActorId: user.id }}
        />
      ) : (
        <p>
          Подключите сервер и подтвердите устройство в разделе «Синхронизация».
          Локальные записи нанесения доступны офлайн; исходные предложения
          сохранены в своей области.
        </p>
      )}
    </section>
  );
}
export function CuttingMaterialsPanel({
  session,
  scope,
  localActorId,
}: Props) {
  const scopeKey = inventoryScopeKey(scope),
    proposals =
      useLiveQuery(
        () => cuttingConsumptionProposals(scope, localActorId),
        [scopeKey, localActorId],
      ) ?? [];
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
                k[2] === "cutting-use-form"
              );
            } catch {
              return false;
            }
          })
          .toArray(),
      [scopeKey, localActorId],
    ) ?? [];
  const [page, setPage] = useState<CustodyPage<CuttingRollSource>>(),
    [history, setHistory] = useState<CustodyPage<CuttingConsumption>>(),
    [step, setStep] = useState(""),
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
    const [p, h] = await Promise.all([
      loadCuttingRoll(session, scope),
      loadCuttingConsumptions(session, scope),
    ]);
    if (p.epoch !== h.epoch)
      throw Error("История изменилась; исходные формы сохранены");
    if (alive.current) {
      setPage(p);
      setHistory(h);
    }
  }
  const selected = forms.find((r) => r.key === formKey);
  return (
    <div className="min-w-0 space-y-3 break-words">
      <button
        className={button}
        disabled={busy}
        onClick={() => void work(refresh)}
      >
        Обновить принятые рулоны Cutting
      </button>
      <p>
        Загрузка и отправка требуют действующего подтверждения устройства.
        Подготовленные формы и предложения сохраняются офлайн; исходная версия
        не подменяется при обновлении остатков.
      </p>
      {page?.items.map((s) => (
        <article className={frame} key={s.receipt.operationId}>
          <p>
            {s.materialCode} · {s.materialName} · партия {s.batchCode} · шаг{" "}
            {s.stepNumber}
          </p>
          <p>
            Длина по измерению Calendaring {s.received / 1000} м; израсходовано{" "}
            {s.consumed / 1000} м; осталось {s.remaining / 1000} м.
          </p>
          <p>
            Рулон {s.receipt.sourceSnapshot.sourceSnapshot.roll.label} · приёмка{" "}
            {s.receipt.operationId} · выпуск{" "}
            {s.receipt.sourceSnapshot.outputLotId}
          </p>
          <p>
            {s.eligible
              ? "Источник доступен для расхода"
              : "Источник удержан / операция недоступна"}{" "}
            · качество выпуска не проверено
          </p>
          <details>
            <summary className="min-h-11 py-2">
              Исходное получение и происхождение
            </summary>
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(s.receipt, null, 2)}
            </pre>
          </details>
        </article>
      ))}
      {page?.nextAfter && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const next = await loadCuttingRoll(
                session,
                scope,
                page.nextAfter!,
              );
              if (next.epoch !== page.epoch)
                throw Error("История изменилась; исходные формы сохранены");
              if (alive.current)
                setPage({ ...next, items: [...page.items, ...next.items] });
            })
          }
        >
          Следующие принятые рулоны
        </button>
      )}
      <label className="block">
        Партия и шаг фактического расхода
        <select
          aria-label="Партия, шаг и SKU расхода Cutting"
          className={control}
          disabled={busy}
          value={step}
          onChange={(e) => setStep(e.target.value)}
        >
          <option value="">Выберите партию и шаг Cutting</option>
          {page?.items
            .filter(
              (s, i, all) =>
                all.findIndex(
                  (x) =>
                    x.productionBatchId === s.productionBatchId &&
                    x.stepNumber === s.stepNumber &&
                    x.materialId === s.materialId,
                ) === i,
            )
            .map((s) => (
              <option
                key={
                  s.productionBatchId + ":" + s.stepNumber + ":" + s.materialId
                }
                value={
                  s.productionBatchId + ":" + s.stepNumber + ":" + s.materialId
                }
              >
                {s.batchCode} · {s.stepNumber} · {s.materialCode}
              </option>
            ))}
        </select>
      </label>
      <button
        className={button}
        disabled={busy || !step || !page?.postingEnabled}
        onClick={() =>
          void work(async () => {
            if (!page) throw Error("Сначала загрузите подтверждённые приёмки");
            const [productionBatchId, stepNumber, materialId] = step.split(":"),
              sources = page.items.filter(
                (s) =>
                  s.productionBatchId === productionBatchId &&
                  String(s.stepNumber) === stepNumber &&
                  s.materialId === materialId,
              ),
              operationId = crypto.randomUUID(),
              key = JSON.stringify([
                scopeKey,
                localActorId,
                "cutting-use-form",
                operationId,
              ]);
            await saveReceivingDraft(key, 0, {
              operationId,
              productionBatchId,
              stepNumber,
              materialId,
              epoch: page.epoch,
              sources: JSON.stringify(sources),
              observedAt: "",
              reference: "",
              actualM: "",
              reason: "",
              evidence: "",
              lines: JSON.stringify([
                { id: crypto.randomUUID(), receiptId: "", metres: "" },
              ]),
            });
            if (alive.current) setFormKey(key);
          })
        }
      >
        Подготовить измерение расхода рулонов
      </button>
      <label className="block">
        Сохранённая форма расхода
        <select
          className={control}
          disabled={busy}
          value={formKey}
          onChange={(e) => setFormKey(e.target.value)}
        >
          <option value="">Выберите сохранённое измерение</option>
          {forms.map((r) => (
            <option key={r.key} value={r.key}>
              {r.fields.operationId.slice(0, 8)} · шаг {r.fields.stepNumber}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <fieldset disabled={busy} className="min-w-0">
          <ConsumptionForm
            key={selected.key}
            {...{ scope, localActorId, initial: selected }}
          />
        </fieldset>
      )}
      <h4>Подтверждённые измерения на сервере</h4>
      {history?.items.map((c) => (
        <article className={frame} key={c.operationId}>
          <p>
            {c.actualLengthMm / 1000} м · {c.reference} · {c.operationId}
          </p>
          <p>
            Наблюдение {new Date(c.observedAt).toLocaleString()} · исполнитель{" "}
            {c.actorId} · записано {c.recordedAt}
          </p>
          <p>
            {c.reason} · {c.evidence}
          </p>
          <details>
            <summary className="min-h-11 py-2">
              Измерение и исходные приёмки
            </summary>
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(c, null, 2)}
            </pre>
          </details>
        </article>
      ))}
      {history?.nextAfter && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const h = await loadCuttingConsumptions(
                session,
                scope,
                history.nextAfter!,
              );
              if (h.epoch !== history.epoch) throw Error("История изменилась");
              if (alive.current)
                setHistory({ ...h, items: [...history.items, ...h.items] });
            })
          }
        >
          Следующие измерения Cutting
        </button>
      )}
      <h4>Исходные предложения расхода Cutting</h4>
      {proposals.map((r) => (
        <article className={frame} key={r.key}>
          <p>
            {r.operationId} ·{" "}
            {
              {
                pending:
                  "Ожидает отправки / исходного повтора; ответ может быть неизвестен",
                accepted: "Сервер подтвердил фактический расход Cutting",
                conflict: "Конфликт — исходное измерение удержано",
                rejected: "Отклонено — требуется сверка",
              }[r.fields.state]
            }
          </p>
          {r.fields.state === "pending" && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await sendCuttingConsumption(
                    session,
                    scope,
                    localActorId,
                    r.key,
                  );
                  await refresh();
                })
              }
            >
              Отправить исходный расход Cutting {r.operationId?.slice(0, 8)}
            </button>
          )}
          <details>
            <summary className="min-h-11 py-2">
              Исходная длина, принятые рулоны и ответ
            </summary>
            <pre className="whitespace-pre-wrap break-all">
              {r.fields.request}
              {"\n"}
              {r.fields.acknowledgement}
              {"\n"}
              {r.fields.error}
            </pre>
          </details>
        </article>
      ))}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
interface Line {
  id: string;
  receiptId: string;
  metres: string;
}
function ConsumptionForm({
  scope,
  localActorId,
  initial,
}: {
  scope: InventoryScope;
  localActorId: string;
  initial: ReceivingDraft;
}) {
  const draft = useOutputDraft(initial.key, initial.fields),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState(false),
    alive = useRef(true),
    running = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  if (!draft.row)
    return <p>{draft.error || "Читаем исходное измерение Cutting…"}</p>;
  const fields = draft.row.fields;
  let sources: CuttingRollSource[], lines: Line[];
  try {
    sources = JSON.parse(fields.sources);
    lines = JSON.parse(fields.lines);
    if (!Array.isArray(sources) || !Array.isArray(lines))
      throw Error("Unknown form");
  } catch {
    return (
      <p role="alert">Исходная форма не распознана и сохранена для сверки.</p>
    );
  }
  function edit(patch: Record<string, string>) {
    draft.edit({ ...fields, ...patch });
    setSaved(false);
  }
  return (
    <form
      aria-label="Фактический расход рулонов в Cutting"
      className={frame}
      onSubmit={(e) => {
        e.preventDefault();
        if (running.current) return;
        running.current = true;
        setBusy(true);
        setError("");
        void (async () => {
          try {
            const row = await draft.flush(),
              f = row.fields,
              choices: CuttingRollSource[] = JSON.parse(f.sources),
              selected: Line[] = JSON.parse(f.lines);
            if (!f.observedAt.trim())
              throw Error("Укажите время фактического измерения расхода");
            const request: CuttingConsumptionRequest = {
              operationId: f.operationId,
              deviceId: scope.deviceId,
              productionBatchId: f.productionBatchId,
              stepNumber: Number(f.stepNumber),
              materialId: f.materialId,
              observedAt: new Date(f.observedAt).getTime(),
              reference: f.reference,
              actualLengthMm: measuredCuttingMm(f.actualM),
              allocations: selected.map((l) => ({
                operationId: l.id,
                receiptId: l.receiptId,
                quantity: measuredCuttingMm(l.metres),
                expectedRevision:
                  choices.find((s) => s.receipt.operationId === l.receiptId)
                    ?.revision ?? 0,
              })),
              reason: f.reason,
              evidence: f.evidence,
            };
            const held = request.allocations.map((a) => {
              const s = choices.find(
                (s) => s.receipt.operationId === a.receiptId,
              );
              if (!s) throw Error("Выберите подтверждённое получение рулонов");
              return s;
            });
            await freezeCuttingConsumption(
              scope,
              localActorId,
              f.epoch,
              request,
              held,
            );
            if (alive.current) setSaved(true);
          } catch (e) {
            if (alive.current) setError(String(e));
          } finally {
            running.current = false;
            if (alive.current) setBusy(false);
          }
        })();
      }}
    >
      <h4>Отдельное измерение фактического расхода</h4>
      <p>
        Введите отдельно измеренную фактически обработанную длину и распределите
        её по принятым рулонам одного SKU. Длина по исходному измерению Calendaring
        задаёт предел; остаток не является новым выходом или измеренным браком.
        Пустая длина неизвестна и не считается нулём.
      </p>
      <p>
        Повторный проход того же участка не добавляйте к расходу исходного
        рулона.
      </p>
      <label className="block">
        Фактически обработано, м
        <input
          className={control}
          inputMode="decimal"
          value={fields.actualM}
          onChange={(e) => edit({ actualM: e.target.value })}
        />
      </label>
      <label className="block">
        Время измерения расхода
        <input
          className={control}
          type="datetime-local"
          value={fields.observedAt}
          onChange={(e) => edit({ observedAt: e.target.value })}
        />
      </label>
      <label className="block">
        Операционная карта или ссылка на запись Cutting
        <input
          className={control}
          value={fields.reference}
          onChange={(e) => edit({ reference: e.target.value })}
        />
      </label>
      {lines.map((line, i) => (
        <fieldset key={line.id} className={frame}>
          <legend>Принятый источник {i + 1}</legend>
          <label className="block">
            Подтверждённая приёмка {i + 1}
            <select
              aria-label={"Подтверждённая приёмка " + (i + 1)}
              className={control}
              value={line.receiptId}
              onChange={(e) =>
                edit({
                  lines: JSON.stringify(
                    lines.map((l) =>
                      l.id === line.id
                        ? { ...l, receiptId: e.target.value }
                        : l,
                    ),
                  ),
                })
              }
            >
              <option value="">Выберите полученный лот</option>
              {sources.map((s) => (
                <option
                  key={s.receipt.operationId}
                  value={s.receipt.operationId}
                  disabled={!s.eligible || s.remaining === 0}
                >
                  {s.receipt.sourceSnapshot.sourceSnapshot.roll.label} ·{" "}
                  {s.materialCode} · остаток {s.remaining / 1000} м ·{" "}
                  {s.receipt.operationId}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            Фактически из этого рулона {i + 1}, м
            <input
              className={control}
              inputMode="decimal"
              value={line.metres}
              onChange={(e) =>
                edit({
                  lines: JSON.stringify(
                    lines.map((l) =>
                      l.id === line.id ? { ...l, metres: e.target.value } : l,
                    ),
                  ),
                })
              }
            />
          </label>
          <button
            type="button"
            className={button}
            onClick={() =>
              edit({
                lines: JSON.stringify(lines.filter((l) => l.id !== line.id)),
              })
            }
          >
            Убрать источник {i + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className={button}
        disabled={lines.length >= 100}
        onClick={() =>
          edit({
            lines: JSON.stringify([
              ...lines,
              { id: crypto.randomUUID(), receiptId: "", metres: "" },
            ]),
          })
        }
      >
        Добавить принятый рулон
      </button>
      <label className="block">
        Основание расхода Cutting
        <input
          className={control}
          value={fields.reason}
          onChange={(e) => edit({ reason: e.target.value })}
        />
      </label>
      <label className="block">
        Свидетельство фактической длины
        <textarea
          className={control}
          value={fields.evidence}
          onChange={(e) => edit({ evidence: e.target.value })}
        />
      </label>
      <button className={button} disabled={busy || !!draft.error}>
        Сохранить расход Cutting без отправки
      </button>
      {saved && (
        <p role="status">
          Исходный расход Cutting сохранён. Отправьте его отдельной кнопкой.
        </p>
      )}
      {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
    </form>
  );
}
