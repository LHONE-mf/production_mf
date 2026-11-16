import React, { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import {
  inventoryOutbox,
  inventoryScopeKey,
  type ReceivingDraft,
} from "../../core/sync/inventoryOutbox";
import {
  loadRollInputs,
  loadRollMaterials,
  freezeRollCommand,
  copyRollInput,
  type RollInput,
  type RollCommand,
} from "../../core/sync/coatedRolls";
import {
  loadRoomMaterials,
  type RoomMaterial,
} from "../../core/sync/slurryConsumption";
import {
  saveReceivingDraft,
  toInventoryBaseUnits,
} from "../../core/sync/inventoryReceiving";
import type { CustodyPage } from "../../core/sync/roomCustody";
import {
  useOutputDraft,
  outputButton as button,
  outputControl as control,
} from "../_common/useOutputDraft";
import {
  optionalRollMeasure,
  rollFrame,
  type CoatedRollProps,
} from "./coatedRollForms";
type Material = { id: string; name: string; code?: string; unit?: string };
export function CoatedRollOutput(
  props: CoatedRollProps & { refreshToken: number },
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
                  k[2] === "coated-roll-output-form"
                );
              } catch {
                return false;
              }
            })
            .toArray(),
        [key, localActorId],
      ) ?? [];
  const [slurry, setSlurry] = useState<CustodyPage<RollInput>>(),
    [foil, setFoil] = useState<CustodyPage<RollInput>>(),
    [tape, setTape] = useState<Awaited<ReturnType<typeof loadRoomMaterials>>>(),
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
    const [s, f, t] = await Promise.all([
      loadRollInputs(session, scope, "slurry"),
      loadRollInputs(session, scope, "foil"),
      loadRoomMaterials(session, scope, "coating"),
    ]);
    if (s.epoch !== f.epoch || s.epoch !== t.epoch)
      throw Error("История изменилась; исходные формы сохранены");
    if (alive.current) {
      setSlurry(s);
      setFoil(f);
      setTape(t);
    }
  }
  useEffect(() => {
    if (props.refreshToken) void work(refresh);
  }, [props.refreshToken]);
  const inputs = [...(slurry?.items ?? []), ...(foil?.items ?? [])],
    groups = inputs.filter(
      (s, index, all) =>
        all.findIndex(
          (x) =>
            x.productionBatchId === s.productionBatchId &&
            x.stepNumber === s.stepNumber,
        ) === index,
    ),
    current = forms.find((r) => r.key === formKey);
  return (
    <section className="min-w-0 space-y-3">
      <h4>Фактический выпуск Coating</h4>
      <p>
        Выберите подтверждённые измерения расхода Slurry и фольги. Они
        связываются целиком с одним выпуском; несколько рулонов сохраняют общие
        родительские количества выпуска. Длина и масса рулонов вводятся
        отдельно. Материальный баланс остаётся несверенным, качество не
        подтверждается.
      </p>
      <button
        className={button}
        disabled={busy}
        onClick={() => void work(refresh)}
      >
        Обновить измерения для выпуска рулонов
      </button>
      {(["slurry", "foil"] as const).map((kind) => {
        const page = kind === "slurry" ? slurry : foil;
        return (
          <div key={kind}>
            <p>
              {kind === "slurry" ? "Slurry" : "Фольга"} · загружено измерений{" "}
              {page?.items.length ?? 0}
            </p>
            {page?.nextAfter && (
              <button
                className={button}
                disabled={busy}
                onClick={() =>
                  void work(async () => {
                    const p = await loadRollInputs(
                      session,
                      scope,
                      kind,
                      page.nextAfter!,
                    );
                    if (p.epoch !== page.epoch)
                      throw Error("История изменилась");
                    if (alive.current)
                      (kind === "slurry" ? setSlurry : setFoil)({
                        ...p,
                        items: [...page.items, ...p.items],
                      });
                  })
                }
              >
                Следующие измерения {kind === "slurry" ? "Slurry" : "фольги"}
              </button>
            )}
          </div>
        );
      })}
      {tape?.nextAfter && (
        <button
          className={button}
          disabled={busy}
          onClick={() =>
            void work(async () => {
              const t = await loadRoomMaterials(
                session,
                scope,
                "coating",
                tape.nextAfter!,
              );
              if (t.epoch !== tape.epoch) throw Error("История изменилась");
              if (alive.current)
                setTape({ ...t, items: [...tape.items, ...t.items] });
            })
          }
        >
          Следующие принятые материалы для ленты
        </button>
      )}
      <fieldset disabled={busy} className="min-w-0 space-y-2">
        <label>
          Партия и шаг выпуска рулонов
          <select
            aria-label="Партия и шаг выпуска рулонов"
            className={control}
            value={step}
            onChange={(e) => setStep(e.target.value)}
          >
            <option value="">Выберите операцию Coating</option>
            {groups.map((s) => (
              <option
                key={s.productionBatchId + ":" + s.stepNumber}
                value={s.productionBatchId + ":" + s.stepNumber}
              >
                {s.batchCode} · шаг {s.stepNumber}
              </option>
            ))}
          </select>
        </label>
        <button
          className={button}
          disabled={!step || !slurry?.postingEnabled || !foil?.postingEnabled}
          onClick={() =>
            void work(async () => {
              if (!slurry || !foil || !tape) throw Error("Загрузите источники");
              const [batch, stepNumber] = step.split(":"),
                materials = await loadRollMaterials(
                  session,
                  scope,
                  batch,
                  Number(stepNumber),
                );
              if (materials.epoch !== slurry.epoch)
                throw Error("История изменилась");
              const operationId = crypto.randomUUID(),
                draftKey = JSON.stringify([
                  key,
                  localActorId,
                  "coated-roll-output-form",
                  operationId,
                ]);
              await saveReceivingDraft(draftKey, 0, {
                operationId,
                epoch: slurry.epoch,
                productionBatchId: batch,
                stepNumber,
                sources: JSON.stringify(
                  inputs.filter(
                    (i) =>
                      i.productionBatchId === batch &&
                      String(i.stepNumber) === stepNumber,
                  ),
                ),
                materials: JSON.stringify(materials.items),
                materialAfter: materials.nextAfter ?? "",
                tape: JSON.stringify(
                  tape.items.filter(
                    (t) =>
                      t.issue.productionBatchId === batch &&
                      String(t.issue.stepNumber) === stepNumber &&
                      t.issue.tapeSpecification?.application ===
                        "coating_support",
                  ),
                ),
                slurryIds: "[]",
                foilIds: "[]",
                tapeIds: "[]",
                tapeStatus: "",
                tapeNote: "",
                rolls: JSON.stringify([
                  {
                    id: crypto.randomUUID(),
                    materialId: "",
                    label: "",
                    lengthM: "",
                    massG: "",
                    disposition: "",
                  },
                ]),
                scrapM: "",
                scrapG: "",
                accountingNote: "",
                observedAt: "",
                reference: "",
                specificationReference: "",
                reason: "",
                evidence: "",
              });
              if (alive.current) setFormKey(draftKey);
            })
          }
        >
          Подготовить выпуск рулонов
        </button>
        <label>
          Сохранённая форма выпуска
          <select
            aria-label="Сохранённая форма выпуска"
            className={control}
            value={formKey}
            onChange={(e) => setFormKey(e.target.value)}
          >
            <option value="">Выберите форму</option>
            {forms.map((r) => (
              <option key={r.key} value={r.key}>
                {r.fields.operationId?.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        {current && (
          <OutputForm key={current.key} {...props} initial={current} />
        )}
      </fieldset>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
interface RollFields {
  id: string;
  materialId: string;
  label: string;
  lengthM: string;
  massG: string;
  disposition: "" | "ready" | "held";
}
function OutputForm({
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
  if (!f) return <p>Восстановление формы выпуска…</p>;
  let inputs: RollInput[],
    materials: Material[],
    tapes: RoomMaterial[],
    rolls: RollFields[],
    sIds: string[],
    fIds: string[],
    tIds: string[];
  try {
    inputs = JSON.parse(f.sources).map(copyRollInput);
    materials = JSON.parse(f.materials);
    tapes = JSON.parse(f.tape);
    rolls = JSON.parse(f.rolls);
    sIds = JSON.parse(f.slurryIds);
    fIds = JSON.parse(f.foilIds);
    tIds = JSON.parse(f.tapeIds);
    if (
      !Array.isArray(rolls) ||
      !rolls.length ||
      rolls.length > 100 ||
      !Array.isArray(materials) ||
      !Array.isArray(tapes) ||
      ![sIds, fIds, tIds].every(Array.isArray)
    )
      throw Error("Invalid form");
  } catch {
    return (
      <p role="alert">
        Повреждённая форма сохранена для сверки. Исходные данные не заменены.
      </p>
    );
  }
  const edit = (field: string, value: string) =>
      draft.edit({ ...f, [field]: value }),
    toggle = (field: string, values: string[], id: string, checked: boolean) =>
      edit(
        field,
        JSON.stringify(
          checked ? [...values, id] : values.filter((x) => x !== id),
        ),
      ),
    rollEdit = (id: string, field: string, value: string) =>
      edit(
        "rolls",
        JSON.stringify(
          rolls.map((r) => (r.id === id ? { ...r, [field]: value } : r)),
        ),
      );
  async function freeze() {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const row = await draft.flush(),
        fields = row.fields,
        all: RollInput[] = JSON.parse(fields.sources).map(copyRollInput),
        selectedSlurry: string[] = JSON.parse(fields.slurryIds),
        selectedFoil: string[] = JSON.parse(fields.foilIds),
        tapeIds: string[] = JSON.parse(fields.tapeIds),
        options: Material[] = JSON.parse(fields.materials),
        tapeSources: RoomMaterial[] = JSON.parse(fields.tape);
      if (!["not_applicable", "unmeasured"].includes(fields.tapeStatus))
        throw Error("Укажите состояние учёта ленты");
      const output = (JSON.parse(fields.rolls) as RollFields[]).map((r) => {
        if (
          !options.some((m) => m.id === r.materialId) ||
          !["ready", "held"].includes(r.disposition)
        )
          throw Error(
            "Выберите материал и состояние каждого фактического рулона",
          );
        return {
          id: r.id,
          materialId: r.materialId,
          label: r.label.trim(),
          measuredLengthMm: toInventoryBaseUnits(r.lengthM, "m", "mm"),
          measuredMassMg: optionalRollMeasure(r.massG, "g"),
          disposition: r.disposition as "ready" | "held",
        };
      });
      const selectedTape =
        fields.tapeStatus === "unmeasured"
          ? tapeIds.map((id) => {
              const t = tapeSources.find((t) => t.issue.id === id);
              if (!t?.eligible || !t.settlement.outstanding)
                throw Error("Выберите доступную принятую ленту");
              return t.issue;
            })
          : [];
      const command: RollCommand = {
        kind: "output",
        request: {
          operationId: fields.operationId,
          deviceId: scope.deviceId,
          productionBatchId: fields.productionBatchId,
          stepNumber: Number(fields.stepNumber),
          slurryConsumptionIds: selectedSlurry,
          foilConsumptionIds: selectedFoil,
          outputs: output,
          tape:
            fields.tapeStatus === "unmeasured"
              ? {
                  status: "unmeasured",
                  issueIds: tapeIds,
                  note: fields.tapeNote.trim(),
                }
              : { status: "not_applicable", note: fields.tapeNote.trim() },
          scrapLengthMm: optionalRollMeasure(fields.scrapM, "m", true),
          scrapMassMg: optionalRollMeasure(fields.scrapG, "g", true),
          accountingNote: fields.accountingNote.trim(),
          observedAt: Date.parse(fields.observedAt),
          specificationReference: fields.specificationReference.trim(),
          reference: fields.reference.trim(),
          reason: fields.reason.trim(),
          evidence: fields.evidence.trim(),
        },
        base: {
          inputs: all.filter((i) =>
            i.kind === "slurry"
              ? selectedSlurry.includes(i.operationId)
              : selectedFoil.includes(i.operationId),
          ),
          tape: selectedTape,
        },
      };
      await freezeRollCommand(scope, localActorId, fields.epoch, command);
      if (alive.current) setSaved(true);
    } catch (e) {
      if (alive.current) setError(String(e));
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }
  const input = (
    field: string,
    label: string,
    required = true,
    type = "text",
  ) => (
    <label>
      {label}
      <input
        aria-label={label}
        className={control}
        required={required}
        type={type}
        maxLength={2000}
        value={f[field]}
        onChange={(e) => edit(field, e.target.value)}
      />
    </label>
  );
  return (
    <form
      aria-label="Измеренный выпуск рулонов"
      className={rollFrame}
      onSubmit={(e) => {
        e.preventDefault();
        void freeze();
      }}
    >
      <fieldset disabled={busy || saved} className="min-w-0 space-y-2">
        <legend>Физически наблюдаемый выпуск</legend>
        {inputs.map((i) => (
          <label
            key={i.kind + i.operationId}
            className="flex min-h-11 items-start gap-2"
          >
            <input
              type="checkbox"
              aria-label={
                "Измерение " +
                (i.kind === "slurry" ? "Slurry" : "фольги") +
                " " +
                i.operationId
              }
              checked={(i.kind === "slurry" ? sIds : fIds).includes(
                i.operationId,
              )}
              disabled={!i.eligible || !!i.claimedBy}
              onChange={(e) =>
                toggle(
                  i.kind === "slurry" ? "slurryIds" : "foilIds",
                  i.kind === "slurry" ? sIds : fIds,
                  i.operationId,
                  e.target.checked,
                )
              }
            />
            <span>
              {i.kind === "slurry" ? "Slurry" : "Фольга"} ·{" "}
              {i.consumption.reference} · {i.operationId} ·{" "}
              {i.claimedBy
                ? "Уже отнесено к выпуску"
                : i.eligible
                  ? "Доступно"
                  : "Удержано"}
            </span>
          </label>
        ))}
        {input(
          "observedAt",
          "Время наблюдения выпуска рулонов",
          true,
          "datetime-local",
        )}
        {input("reference", "Карта / операция выпуска рулонов")}
        {input("specificationReference", "Спецификация выпуска рулонов")}
        {f.materialAfter && (
          <button
            type="button"
            className={button}
            onClick={() => {
              if (running.current) return;
              running.current = true;
              setBusy(true);
              void loadRollMaterials(
                session,
                scope,
                f.productionBatchId,
                Number(f.stepNumber),
                f.materialAfter,
              )
                .then((p) => {
                  if (p.epoch !== f.epoch) throw Error("История изменилась");
                  draft.edit({
                    ...f,
                    materials: JSON.stringify([...materials, ...p.items]),
                    materialAfter: p.nextAfter ?? "",
                  });
                })
                .catch((e) => setError(String(e)))
                .finally(() => {
                  running.current = false;
                  setBusy(false);
                });
            }}
          >
            Следующие материалы выпуска
          </button>
        )}
        {rolls.map((r, index) => (
          <div className={rollFrame} key={r.id}>
            <label>
              Материал рулона {index + 1}
              <select
                aria-label={"Материал рулона " + (index + 1)}
                required
                className={control}
                value={r.materialId}
                onChange={(e) => rollEdit(r.id, "materialId", e.target.value)}
              >
                <option value="">Выберите явно заданный материал</option>
                {materials.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.code} · {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Физическая маркировка рулона {index + 1}
              <input
                aria-label={"Физическая маркировка рулона " + (index + 1)}
                required
                maxLength={200}
                className={control}
                value={r.label}
                onChange={(e) => rollEdit(r.id, "label", e.target.value)}
              />
            </label>
            <label>
              Измеренная длина рулона {index + 1}, м
              <input
                aria-label={"Измеренная длина рулона " + (index + 1) + ", м"}
                required
                inputMode="decimal"
                maxLength={30}
                className={control}
                value={r.lengthM}
                onChange={(e) => rollEdit(r.id, "lengthM", e.target.value)}
              />
            </label>
            <label>
              Измеренная масса рулона {index + 1}, г · пусто = не измерена
              <input
                aria-label={"Измеренная масса рулона " + (index + 1) + ", г"}
                inputMode="decimal"
                maxLength={30}
                className={control}
                value={r.massG}
                onChange={(e) => rollEdit(r.id, "massG", e.target.value)}
              />
            </label>
            <label>
              Состояние рулона {index + 1}
              <select
                aria-label={"Состояние рулона " + (index + 1)}
                required
                className={control}
                value={r.disposition}
                onChange={(e) => rollEdit(r.id, "disposition", e.target.value)}
              >
                <option value="">Укажите состояние</option>
                <option value="ready">
                  Готов к физической передаче · качество не подтверждено
                </option>
                <option value="held">Удержан · передача запрещена</option>
              </select>
            </label>
            {rolls.length > 1 && (
              <button
                type="button"
                className={button}
                onClick={() =>
                  edit(
                    "rolls",
                    JSON.stringify(rolls.filter((x) => x.id !== r.id)),
                  )
                }
              >
                Убрать рулон {index + 1}
              </button>
            )}
          </div>
        ))}
        <button
          type="button"
          className={button}
          disabled={rolls.length >= 100}
          onClick={() =>
            edit(
              "rolls",
              JSON.stringify([
                ...rolls,
                {
                  id: crypto.randomUUID(),
                  materialId: "",
                  label: "",
                  lengthM: "",
                  massG: "",
                  disposition: "",
                },
              ]),
            )
          }
        >
          Добавить фактический рулон
        </button>
        <label>
          Учёт ленты Coating
          <select
            aria-label="Учёт ленты Coating"
            required
            className={control}
            value={f.tapeStatus}
            onChange={(e) => edit("tapeStatus", e.target.value)}
          >
            <option value="">Укажите состояние учёта</option>
            <option value="unmeasured">
              Лента принята · фактический расход пока не измерен
            </option>
            <option value="not_applicable">
              Не применяется по указанной карте операции
            </option>
          </select>
        </label>
        {f.tapeStatus === "unmeasured" &&
          tapes.map((t) => (
            <label key={t.issue.id} className="flex min-h-11 items-start gap-2">
              <input
                type="checkbox"
                checked={tIds.includes(t.issue.id)}
                disabled={!t.eligible || !t.settlement.outstanding}
                onChange={(e) =>
                  toggle("tapeIds", tIds, t.issue.id, e.target.checked)
                }
              />
              <span>
                {t.materialCode} · {t.issue.source?.manufacturerLot} · получено{" "}
                {t.issue.quantity} рулонов · это ссылка на приёмку, количество
                расхода не определено
              </span>
            </label>
          ))}
        {input("tapeNote", "Пояснение учёта ленты")}
        {input(
          "scrapM",
          "Измеренная длина брака, м · пусто = не измерена",
          false,
        )}
        {input(
          "scrapG",
          "Измеренная масса брака, г · пусто = не измерена",
          false,
        )}
        {input("accountingNote", "Несверенные количества и потери выпуска")}
        {input("reason", "Основание выпуска рулонов")}
        {input("evidence", "Свидетельство фактического выпуска")}
        <p>
          Нулевой брак укажите явно, только если он измерен. Выпуск сохраняет
          общий набор исходных измерений; количество материала по каждому рулону
          не рассчитывается.
        </p>
        <button className={button}>
          Сохранить выпуск рулонов без отправки
        </button>
      </fieldset>
      {saved && (
        <p role="status">
          Исходный выпуск сохранён. Отправьте его отдельным действием ниже.
        </p>
      )}
      {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
    </form>
  );
}
