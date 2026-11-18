import React, { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  inventoryOutbox,
  inventoryScopeKey,
  type ReceivingDraft,
} from "../../core/sync/inventoryOutbox";
import {
  saveReceivingDraft,
  toInventoryBaseUnits,
} from "../../core/sync/inventoryReceiving";
import {
  loadCalenderedInputs,
  loadCalenderedMaterials,
  freezeCalenderedCommand,
  copyCalenderedInput,
  type CalenderedInput,
} from "../../core/sync/calenderedRolls";
import type { CustodyPage } from "../../core/sync/roomCustody";
import {
  useOutputDraft,
  outputButton as button,
  outputControl as control,
} from "../_common/useOutputDraft";
import {
  optionalRollMeasure,
  rollFrame,
  type CalenderedRollProps,
} from "./calenderedRollForms";
type Material = { id: string; name: string; code?: string };
type Row = {
  id: string;
  materialId: string;
  label: string;
  lengthM: string;
  massG: string;
  disposition: string;
};
const blankRoll = (): Row => ({
  id: crypto.randomUUID(),
  materialId: "",
  label: "",
  lengthM: "",
  massG: "",
  disposition: "",
});
export function CalenderedRollOutput(
  props: CalenderedRollProps & { refreshToken: number },
) {
  const { scope, session, localActorId } = props,
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
                  k[2] === "calendered-roll-output-form"
                );
              } catch {
                return false;
              }
            })
            .toArray(),
        [key, localActorId],
      ) ?? [];
  const [page, setPage] = useState<CustodyPage<CalenderedInput>>(),
    [group, setGroup] = useState(""),
    [formKey, setFormKey] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    alive = useRef(true),
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
    const p = await loadCalenderedInputs(session, scope);
    if (alive.current) setPage(p);
  }
  useEffect(() => {
    if (props.refreshToken) void work(refresh);
  }, [props.refreshToken]);
  const groupKey = (i: CalenderedInput) =>
      [i.productionBatchId, i.stepNumber, i.materialId].join(":"),
    groups = (page?.items ?? []).filter(
      (s, i, a) => a.findIndex((x) => groupKey(x) === groupKey(s)) === i,
    ),
    selected = forms.find((f) => f.key === formKey);
  return (
    <section className="min-w-0 space-y-3">
      <h4>Фактический выпуск Calendaring</h4>
      <p>
        Выберите подтверждённые измерения входного расхода. Каждое относится
        целиком к одному выпуску; несколько рулонов сохраняют общие родительские
        количества выпуска. Измерьте выход отдельно. Качество не подтверждено,
        материальный баланс остаётся несверенным.
      </p>
      <button
        className={button}
        disabled={busy}
        onClick={() => void work(refresh)}
      >
        Обновить измерения для выпуска Calendaring
      </button>
      <p>Загружено измерений: {page?.items.length ?? 0}</p>
      {page?.nextAfter && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const p = await loadCalenderedInputs(
                session,
                scope,
                page.nextAfter!,
              );
              if (p.epoch !== page.epoch)
                throw Error("История изменилась; исходные формы сохранены");
              if (alive.current)
                setPage({ ...p, items: [...page.items, ...p.items] });
            })
          }
        >
          Следующие измерения Calendaring
        </button>
      )}
      <fieldset disabled={busy} className="min-w-0 space-y-2">
        <label className="block">
          Партия, шаг и входной SKU выпуска
          <select
            aria-label="Партия, шаг и входной SKU выпуска"
            className={control}
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="">Выберите фактические входные измерения</option>
            {groups.map((s) => (
              <option key={groupKey(s)} value={groupKey(s)}>
                {s.batchCode} · шаг {s.stepNumber} ·{" "}
                {s.materialCode ?? s.materialId} · {s.materialName ?? ""}
              </option>
            ))}
          </select>
        </label>
        <button
          className={button}
          disabled={!group || !page?.postingEnabled}
          onClick={() =>
            void work(async () => {
              if (!page) throw Error("Загрузите измерения");
              const inputs = page.items.filter((i) => groupKey(i) === group);
              if (!inputs.length) throw Error("Выберите входные измерения");
              const first = inputs[0],
                materials = await loadCalenderedMaterials(
                  session,
                  scope,
                  first.productionBatchId,
                  first.stepNumber,
                );
              if (materials.epoch !== page.epoch)
                throw Error("История изменилась; исходные формы сохранены");
              const operationId = crypto.randomUUID(),
                formKey = JSON.stringify([
                  key,
                  localActorId,
                  "calendered-roll-output-form",
                  operationId,
                ]);
              await saveReceivingDraft(formKey, 0, {
                operationId,
                productionBatchId: first.productionBatchId,
                stepNumber: String(first.stepNumber),
                epoch: page.epoch,
                inputs: JSON.stringify(inputs),
                materials: JSON.stringify(materials.items),
                materialAfter: materials.nextAfter ?? "",
                selectedIds: "[]",
                rolls: JSON.stringify([blankRoll()]),
                scrapLengthM: "",
                scrapMassG: "",
                accountingNote: "",
                observedAt: "",
                specificationReference: "",
                reference: "",
                reason: "",
                evidence: "",
              });
              if (alive.current) setFormKey(formKey);
            })
          }
        >
          Подготовить выпуск Calendaring
        </button>
        <label className="block">
          Сохранённая форма выпуска
          <select
            aria-label="Сохранённая форма выпуска Calendaring"
            className={control}
            value={formKey}
            onChange={(e) => setFormKey(e.target.value)}
          >
            <option value="">Выберите сохранённый выпуск</option>
            {forms.map((f) => (
              <option key={f.key} value={f.key}>
                {f.fields.operationId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <OutputForm key={selected.key} {...props} initial={selected} />
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
function OutputForm({
  scope,
  session,
  localActorId,
  initial,
}: CalenderedRollProps & { initial: ReceivingDraft }) {
  const draft = useOutputDraft(initial.key, initial.fields),
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
  if (!draft.row) return <p>{draft.error || "Читаем исходный выпуск…"}</p>;
  const fields = draft.row.fields;
  let inputs: CalenderedInput[],
    materials: Material[],
    rolls: Row[],
    ids: string[];
  try {
    inputs = JSON.parse(fields.inputs).map(copyCalenderedInput);
    materials = JSON.parse(fields.materials);
    rolls = JSON.parse(fields.rolls);
    ids = JSON.parse(fields.selectedIds);
    if (
      !Array.isArray(materials) ||
      !materials.every(
        (m) => m && typeof m.id === "string" && typeof m.name === "string",
      ) ||
      !Array.isArray(rolls) ||
      !rolls.every(
        (r) =>
          r &&
          [
            "id",
            "materialId",
            "label",
            "lengthM",
            "massG",
            "disposition",
          ].every((k) => typeof r[k as keyof Row] === "string"),
      ) ||
      !Array.isArray(ids) ||
      !ids.every((i) => typeof i === "string")
    )
      throw Error("Invalid form");
  } catch {
    return (
      <p role="alert">Исходная форма не распознана и сохранена для сверки.</p>
    );
  }
  function edit(patch: Record<string, string>) {
    draft.edit({ ...fields, ...patch });
    setSaved(false);
  }
  const updateRoll = (id: string, patch: Partial<Row>) =>
    edit({
      rolls: JSON.stringify(
        rolls.map((r) => (r.id === id ? { ...r, ...patch } : r)),
      ),
    });
  async function submit() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const f = (await draft.flush()).fields,
        choices: CalenderedInput[] = JSON.parse(f.inputs).map(
          copyCalenderedInput,
        ),
        selected: string[] = JSON.parse(f.selectedIds);
      if (!f.observedAt.trim())
        throw Error("Укажите время отдельного измерения выхода");
      await freezeCalenderedCommand(scope, localActorId, f.epoch, {
        kind: "output",
        request: {
          operationId: f.operationId,
          deviceId: scope.deviceId,
          productionBatchId: f.productionBatchId,
          stepNumber: Number(f.stepNumber),
          consumptionIds: selected,
          outputs: (JSON.parse(f.rolls) as Row[]).map((r) => ({
            id: r.id,
            materialId: r.materialId,
            label: r.label,
            measuredLengthMm: toInventoryBaseUnits(r.lengthM, "m", "mm"),
            measuredMassMg: optionalRollMeasure(r.massG, "g"),
            disposition: r.disposition as "ready" | "held",
          })),
          scrapLengthMm: optionalRollMeasure(f.scrapLengthM, "m", true),
          scrapMassMg: optionalRollMeasure(f.scrapMassG, "g", true),
          accountingNote: f.accountingNote,
          observedAt: new Date(f.observedAt).getTime(),
          specificationReference: f.specificationReference,
          reference: f.reference,
          reason: f.reason,
          evidence: f.evidence,
        },
        base: {
          inputs: selected.map((id) => {
            const i = choices.find((i) => i.operationId === id);
            if (!i) throw Error("Выберите исходное измерение");
            return i;
          }),
        },
      });
      if (alive.current) setSaved(true);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  return (
    <form
      aria-label="Измеренный выпуск Calendaring"
      className={rollFrame}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset disabled={busy || saved} className="min-w-0 space-y-3">
        <legend>Физически наблюдаемый выход Calendaring</legend>
        {inputs.map((i) => (
          <label className="block" key={i.operationId}>
            <input
              type="checkbox"
              checked={ids.includes(i.operationId)}
              disabled={!i.eligible || !!i.claimedBy}
              onChange={(e) =>
                edit({
                  selectedIds: JSON.stringify(
                    e.target.checked
                      ? [...ids, i.operationId]
                      : ids.filter((id) => id !== i.operationId),
                  ),
                })
              }
            />{" "}
            {i.consumption.reference} · вход {i.consumption.actualLengthMm} мм ·{" "}
            {i.claimedBy
              ? "уже отнесено к выпуску"
              : i.eligible
                ? "доступно"
                : "удержано"}
          </label>
        ))}
        <label className="block">
          Время наблюдения выпуска
          <input
            className={control}
            type="datetime-local"
            value={fields.observedAt}
            onChange={(e) => edit({ observedAt: e.target.value })}
          />
        </label>
        {rolls.map((r, index) => (
          <fieldset className={rollFrame} key={r.id}>
            <legend>Выходной рулон {index + 1}</legend>
            <label className="block">
              SKU выхода {index + 1}
              <select
                aria-label={"SKU выхода " + (index + 1)}
                className={control}
                value={r.materialId}
                onChange={(e) =>
                  updateRoll(r.id, { materialId: e.target.value })
                }
              >
                <option value="">Выберите явную спецификацию материала</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.code} · {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              Фактическая маркировка рулона {index + 1}
              <input
                className={control}
                value={r.label}
                onChange={(e) => updateRoll(r.id, { label: e.target.value })}
              />
            </label>
            <label className="block">
              Измеренная длина рулона {index + 1}, м
              <input
                className={control}
                inputMode="decimal"
                value={r.lengthM}
                onChange={(e) => updateRoll(r.id, { lengthM: e.target.value })}
              />
            </label>
            <label className="block">
              Измеренная масса рулона {index + 1}, г · пусто = не измерена
              <input
                className={control}
                inputMode="decimal"
                value={r.massG}
                onChange={(e) => updateRoll(r.id, { massG: e.target.value })}
              />
            </label>
            <label className="block">
              Состояние передачи рулона {index + 1}
              <select
                aria-label={"Состояние передачи рулона " + (index + 1)}
                className={control}
                value={r.disposition}
                onChange={(e) =>
                  updateRoll(r.id, { disposition: e.target.value })
                }
              >
                <option value="">Укажите состояние</option>
                <option value="ready">
                  Готов к предложению · качество не подтверждено
                </option>
                <option value="held">Удержан</option>
              </select>
            </label>
            <button
              type="button"
              className={button}
              onClick={() =>
                edit({
                  rolls: JSON.stringify(rolls.filter((x) => x.id !== r.id)),
                })
              }
            >
              Убрать рулон {index + 1}
            </button>
          </fieldset>
        ))}
        {fields.materialAfter && (
          <button
            type="button"
            className={button}
            onClick={() => {
              if (running.current) return;
              running.current = true;
              setBusy(true);
              setError("");
              void (async () => {
                try {
                  const f = (await draft.flush()).fields,
                    p = await loadCalenderedMaterials(
                      session,
                      scope,
                      f.productionBatchId,
                      Number(f.stepNumber),
                      f.materialAfter,
                    );
                  if (p.epoch !== f.epoch) throw Error("История изменилась");
                  draft.edit({
                    ...f,
                    materials: JSON.stringify([
                      ...JSON.parse(f.materials),
                      ...p.items,
                    ]),
                    materialAfter: p.nextAfter ?? "",
                  });
                } catch (e) {
                  if (alive.current) setError(String(e));
                } finally {
                  running.current = false;
                  if (alive.current) setBusy(false);
                }
              })();
            }}
          >
            Следующие SKU выхода
          </button>
        )}
        <button
          type="button"
          className={button}
          disabled={rolls.length >= 100}
          onClick={() =>
            edit({ rolls: JSON.stringify([...rolls, blankRoll()]) })
          }
        >
          Добавить выходной рулон
        </button>
        <label className="block">
          Измеренная длина обрези, м · пусто = неизвестно
          <input
            className={control}
            inputMode="decimal"
            value={fields.scrapLengthM}
            onChange={(e) => edit({ scrapLengthM: e.target.value })}
          />
        </label>
        <label className="block">
          Измеренная масса брака, г · пусто = неизвестно
          <input
            className={control}
            inputMode="decimal"
            value={fields.scrapMassG}
            onChange={(e) => edit({ scrapMassG: e.target.value })}
          />
        </label>
        <p>
          Измерения входа и выхода сохраняются независимо. Неизвестная обрезь не
          считается нулём; остатки входных рулонов не становятся новым выходом.
          Готовность передачи не подтверждает качество.
        </p>
        {(
          [
            ["accountingNote", "Что известно о балансе и потерях"],
            ["specificationReference", "Спецификация выхода"],
            ["reference", "Карта или операция выпуска"],
            ["reason", "Основание выпуска"],
            ["evidence", "Свидетельство отдельного измерения выхода"],
          ] as const
        ).map(([key, label]) => (
          <label className="block" key={key}>
            {label}
            <textarea
              className={control}
              value={fields[key]}
              onChange={(e) => edit({ [key]: e.target.value })}
            />
          </label>
        ))}
        <button className={button} disabled={!!draft.error}>
          Сохранить выпуск Calendaring без отправки
        </button>
      </fieldset>
      {saved && (
        <p role="status">
          Исходный выпуск Calendaring сохранён. Отправьте его отдельной кнопкой.
        </p>
      )}
      {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
    </form>
  );
}
