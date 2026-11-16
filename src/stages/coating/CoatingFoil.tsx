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
import {
  saveReceivingDraft,
  toInventoryBaseUnits,
} from "../../core/sync/inventoryReceiving";
import {
  loadFoilSources,
  loadFoilHistory,
  freezeFoilConsumption,
  sendFoilConsumption,
  foilProposals,
  copyFoilSource,
  type FoilSource,
  type FoilConsumption,
} from "../../core/sync/coatingFoil";
import type { CustodyPage } from "../../core/sync/roomCustody";
import {
  useOutputDraft,
  outputButton as button,
  outputControl as control,
} from "../_common/useOutputDraft";
const frame =
  "min-w-0 space-y-2 break-words rounded border border-slate-600 p-3";
interface Props {
  session: HybridSession;
  scope: InventoryScope;
  localActorId: string;
}
export function CoatingFoil() {
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
    <section className={frame}>
      <h3>Фактический расход коллекторной фольги</h3>
      <p>
        Выберите фактическую фольгу по спецификации и принятому лоту. Укажите
        независимо измеренный расход. Выдача или расчёт длины покрытия сами по
        себе не подтверждают расход.
      </p>
      {connection && scope && user ? (
        <CoatingFoilPanel
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
          Сохранённые формы остаются на устройстве.
        </p>
      )}
    </section>
  );
}
export function CoatingFoilPanel({ session, scope, localActorId }: Props) {
  const scopeKey = inventoryScopeKey(scope),
    proposals =
      useLiveQuery(
        () => foilProposals(scope, localActorId),
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
                k[2] === "coating-foil-form"
              );
            } catch {
              return false;
            }
          })
          .toArray(),
      [scopeKey, localActorId],
    ) ?? [];
  const [page, setPage] = useState<CustodyPage<FoilSource>>(),
    [history, setHistory] = useState<CustodyPage<FoilConsumption>>(),
    [selection, setSelection] = useState(""),
    [formKey, setFormKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
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
      loadFoilSources(session, scope),
      loadFoilHistory(session, scope),
    ]);
    if (p.epoch !== h.epoch)
      throw Error("История изменилась; исходные формы сохранены");
    if (alive.current) {
      setPage(p);
      setHistory(h);
    }
  }
  const group = (s: FoilSource) =>
      [s.issue.productionBatchId, s.issue.stepNumber, s.issue.materialId].join(
        ":",
      ),
    selected = page?.items.filter((s) => group(s) === selection) ?? [],
    current = forms.find((r) => r.key === formKey);
  return (
    <div className="min-w-0 space-y-3 break-words">
      <p>
        Материалы показаны по подтверждённым выдачам в Coating. Назначение
        «фольга» подтверждается выбранной спецификацией, а не названием
        материала. Эта форма поддерживает расход в единице выдачи: масса или
        длина. Для рулонов требуется отдельно определённый способ измерения;
        перевод рулонов в метры не выполняется.
      </p>
      <button
        className={button}
        disabled={busy}
        onClick={() => void work(refresh)}
      >
        Обновить остатки фольги
      </button>
      {page?.items.map((s) => (
        <article key={s.issue.id} className={frame}>
          <p>
            {s.materialCode} · {s.materialName} · партия {s.batchCode} · шаг{" "}
            {s.issue.stepNumber}
          </p>
          <p>
            Лот {s.issue.source?.manufacturerLot} · получено{" "}
            {s.settlement.issued} {s.issue.unit}; расход {s.settlement.consumed}
            ; возврат {s.settlement.returned}; брак {s.settlement.scrapped};
            осталось {s.settlement.outstanding} {s.issue.unit}.
          </p>
          <p>
            {s.eligible
              ? "Источник доступен"
              : "Источник удержан / операция недоступна"}{" "}
            · версия остатка {s.settlement.revision}
          </p>
          <details>
            <summary className="min-h-11 py-2">
              Происхождение полученного материала
            </summary>
            <pre className="whitespace-pre-wrap break-all">
              {JSON.stringify(s.issue, null, 2)}
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
              const p = await loadFoilSources(session, scope, page.nextAfter!);
              if (p.epoch !== page.epoch) throw Error("История изменилась");
              if (alive.current)
                setPage({ ...p, items: [...page.items, ...p.items] });
            })
          }
        >
          Следующие материалы фольги
        </button>
      )}
      <fieldset disabled={busy} className="min-w-0 space-y-2">
        <label>
          Партия, шаг и материал фольги
          <select
            aria-label="Партия, шаг и материал фольги"
            className={control}
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
          >
            <option value="">Выберите фактическую фольгу по документу</option>
            {page?.items
              .filter(
                (s, i, all) =>
                  all.findIndex((x) => group(x) === group(s)) === i,
              )
              .map((s) => (
                <option key={group(s)} value={group(s)}>
                  {s.batchCode} · {s.issue.stepNumber} · {s.materialCode} ·{" "}
                  {s.issue.unit}
                </option>
              ))}
          </select>
        </label>
        <button
          className={button}
          disabled={!selected.length || !page?.postingEnabled}
          onClick={() =>
            void work(async () => {
              if (!page || !selected.length)
                throw Error("Загрузите принятые источники");
              const operationId = crypto.randomUUID(),
                key = JSON.stringify([
                  scopeKey,
                  localActorId,
                  "coating-foil-form",
                  operationId,
                ]);
              await saveReceivingDraft(key, 0, {
                operationId,
                epoch: page.epoch,
                sources: JSON.stringify(selected),
                observedAt: "",
                reference: "",
                specificationReference: "",
                actual: "",
                reason: "",
                evidence: "",
                lines: JSON.stringify([
                  { id: crypto.randomUUID(), issueId: "", amount: "" },
                ]),
              });
              if (alive.current) setFormKey(key);
            })
          }
        >
          Подготовить измерение расхода фольги
        </button>
        <label>
          Сохранённая форма фольги
          <select
            aria-label="Сохранённая форма фольги"
            className={control}
            value={formKey}
            onChange={(e) => setFormKey(e.target.value)}
          >
            <option value="">Выберите форму</option>
            {forms.map((r) => (
              <option key={r.key} value={r.key}>
                {r.fields.operationId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {current && (
          <FoilForm
            key={current.key}
            {...{ scope, localActorId, initial: current }}
          />
        )}
      </fieldset>
      <h4>Подтверждённые измерения фольги</h4>
      {history?.items.map((c) => (
        <article key={c.operationId} className={frame}>
          <p>
            {c.actualQuantity} {c.unit} · {c.reference} ·{" "}
            {c.specificationReference}
          </p>
          <p>
            {new Date(c.observedAt).toLocaleString()} · исполнитель {c.actorId}
          </p>
          <details>
            <summary className="min-h-11 py-2">
              Измерение и исходные лоты
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
              const h = await loadFoilHistory(
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
          Следующие измерения фольги
        </button>
      )}
      <h4>Исходные предложения расхода фольги</h4>
      {proposals.map((r) => (
        <article key={r.key} className={frame}>
          <p>
            {r.operationId} ·{" "}
            {
              (
                {
                  pending: "Ожидает отправки / исходного повтора",
                  accepted: "Сервер подтвердил расход фольги",
                  conflict: "Конфликт — исходное измерение удержано",
                  rejected: "Отклонено — требуется сверка",
                } as Record<string, string>
              )[r.fields.state]
            }
          </p>
          {r.fields.state === "pending" && (
            <button
              className={button}
              disabled={busy}
              onClick={() =>
                void work(async () => {
                  await sendFoilConsumption(
                    session,
                    scope,
                    localActorId,
                    r.key,
                  );
                  await refresh();
                })
              }
            >
              Отправить исходный расход фольги {r.operationId?.slice(0, 8)}
            </button>
          )}
          <details>
            <summary className="min-h-11 py-2">Исходный запрос и ответ</summary>
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
  issueId: string;
  amount: string;
}
function FoilForm({
  scope,
  localActorId,
  initial,
}: {
  scope: InventoryScope;
  localActorId: string;
  initial: ReceivingDraft;
}) {
  const draft = useOutputDraft(initial.key, initial.fields),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState(false),
    running = useRef(false),
    alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const fields = draft.row?.fields;
  if (!fields) return <p>Восстановление исходной формы…</p>;
  let sources: FoilSource[], lines: Line[];
  try {
    sources = JSON.parse(fields.sources).map(copyFoilSource);
    lines = JSON.parse(fields.lines);
    if (
      !sources.length ||
      !Array.isArray(lines) ||
      !lines.length ||
      lines.length > 100 ||
      lines.some(
        (l) =>
          !l ||
          typeof l.id !== "string" ||
          typeof l.issueId !== "string" ||
          typeof l.amount !== "string",
      )
    )
      throw Error("Invalid form");
  } catch {
    return (
      <p role="alert">
        Повреждённая форма сохранена для сверки. Исходные данные не заменены.
      </p>
    );
  }
  const unit = sources[0].issue.unit === "mm" ? "m" : "g",
    label = unit === "m" ? "м" : "г";
  const edit = (key: string, value: string) =>
    draft.edit({ ...fields, [key]: value });
  async function freeze() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const row = await draft.flush(),
        f = row.fields,
        all: FoilSource[] = JSON.parse(f.sources),
        actual = toInventoryBaseUnits(f.actual, unit, all[0].issue.unit),
        allocations = (JSON.parse(f.lines) as Line[]).map((l) => {
          const s = all.find((s) => s.issue.id === l.issueId);
          if (!s) throw Error("Выберите каждый фактический лот");
          return {
            operationId: l.id,
            issueId: s.issue.id,
            quantity: toInventoryBaseUnits(l.amount, unit, s.issue.unit),
            expectedSettlementRevision: s.settlement.revision,
          };
        }),
        first = all[0].issue;
      await freezeFoilConsumption(
        scope,
        localActorId,
        f.epoch,
        {
          operationId: f.operationId,
          deviceId: scope.deviceId,
          productionBatchId: first.productionBatchId,
          stepNumber: first.stepNumber,
          materialId: first.materialId,
          unit: first.unit as "mg" | "mm",
          observedAt: Date.parse(f.observedAt),
          reference: f.reference.trim(),
          specificationReference: f.specificationReference.trim(),
          actualQuantity: actual,
          allocations,
          reason: f.reason.trim(),
          evidence: f.evidence.trim(),
        },
        allocations.map((a) => all.find((s) => s.issue.id === a.issueId)!),
      );
      if (alive.current) setSaved(true);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const input = (key: string, title: string, type = "text") => (
    <label>
      {title}
      <input
        aria-label={title}
        required
        maxLength={2000}
        type={type}
        inputMode={key === "actual" ? "decimal" : undefined}
        className={control}
        value={fields[key]}
        onChange={(e) => edit(key, e.target.value)}
      />
    </label>
  );
  return (
    <form
      aria-label="Измерение расхода фольги"
      className={frame}
      onSubmit={(e) => {
        e.preventDefault();
        void freeze();
      }}
    >
      <fieldset disabled={busy || saved} className="min-w-0 space-y-2">
        <legend>Отдельное фактическое измерение фольги</legend>
        {input(
          "observedAt",
          "Время фактического расхода фольги",
          "datetime-local",
        )}
        {input("reference", "Карта / операция расхода фольги")}
        {input("specificationReference", "Спецификация выбранной фольги")}
        {input("actual", "Общий измеренный расход фольги, " + label)}
        <p>
          Распределите ровно измеренный расход по явно выбранным лотам одного
          материала. Остаток сохраняет исходную единицу {sources[0].issue.unit}.
          Ничего не рассчитывается из длины покрытия или размеров рулона.
        </p>
        {lines.map((l, index) => (
          <div key={l.id} className={frame}>
            <label>
              Принятый лот фольги {index + 1}
              <select
                aria-label={"Принятый лот фольги " + (index + 1)}
                required
                className={control}
                value={l.issueId}
                onChange={(e) =>
                  edit(
                    "lines",
                    JSON.stringify(
                      lines.map((x) =>
                        x.id === l.id ? { ...x, issueId: e.target.value } : x,
                      ),
                    ),
                  )
                }
              >
                <option value="">Выберите лот</option>
                {sources.map((s) => (
                  <option
                    key={s.issue.id}
                    value={s.issue.id}
                    disabled={!s.eligible || !s.settlement.outstanding}
                  >
                    {s.issue.source?.manufacturerLot} · осталось{" "}
                    {s.settlement.outstanding} {s.issue.unit}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Фактически по лоту {index + 1}, {label}
              <input
                aria-label={"Фактически по лоту " + (index + 1) + ", " + label}
                required
                inputMode="decimal"
                maxLength={30}
                className={control}
                value={l.amount}
                onChange={(e) =>
                  edit(
                    "lines",
                    JSON.stringify(
                      lines.map((x) =>
                        x.id === l.id ? { ...x, amount: e.target.value } : x,
                      ),
                    ),
                  )
                }
              />
            </label>
            {lines.length > 1 && (
              <button
                type="button"
                className={button}
                onClick={() =>
                  edit(
                    "lines",
                    JSON.stringify(lines.filter((x) => x.id !== l.id)),
                  )
                }
              >
                Удалить лот {index + 1}
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className={button}
          disabled={lines.length >= 100}
          onClick={() =>
            edit(
              "lines",
              JSON.stringify([
                ...lines,
                { id: crypto.randomUUID(), issueId: "", amount: "" },
              ]),
            )
          }
        >
          Добавить лот фольги
        </button>
        {input("reason", "Основание расхода фольги")}
        {input("evidence", "Свидетельство измерения фольги")}
        <button className={button}>Сохранить расход фольги без отправки</button>
      </fieldset>
      {saved && (
        <p role="status">
          Исходное измерение фольги сохранено. Отправка выполняется отдельно.
        </p>
      )}
      {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
    </form>
  );
}
