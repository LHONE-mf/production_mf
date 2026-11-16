import React, { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { useAuthStore } from "../../core/store/authStore";
import { useServerConnection } from "../../core/sync/serverConnection";
import {
  inventoryScopeKey,
  type InventoryScope,
} from "../../core/sync/inventoryOutbox";
import { rollFrame, type CoatedRollProps } from "./coatedRollForms";
import { rollProposals, sendRollCommand } from "../../core/sync/coatedRolls";
import { outputButton as button } from "../_common/useOutputDraft";
import { CoatedRollOutput } from "./CoatedRollOutput";
import { CoatedRollTransfers } from "./CoatedRollTransfers";
export function CoatedRolls({ room }: { room: "coating" | "calendaring" }) {
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
    <section className={rollFrame}>
      <h3>
        {room === "coating"
          ? "Измеренный выпуск и передача рулонов"
          : "Подтверждённая приёмка рулонов"}
      </h3>
      <p>
        Передача проходит напрямую между цехами. Рулон учитывается как отдельная
        физическая единица с измеренной длиной. Качество выпуска не
        подтверждено; материальный баланс остаётся несверенным.
      </p>
      {connection && scope && user ? (
        <CoatedRollPanel
          key={
            inventoryScopeKey(scope) +
            user.id +
            connection.session.deviceProofExpiresAt +
            room
          }
          {...{
            session: connection.session,
            scope,
            localActorId: user.id,
            room,
          }}
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
export function CoatedRollPanel(
  props: CoatedRollProps & { room: "coating" | "calendaring" },
) {
  const { scope, session, localActorId, room } = props,
    proposals =
      useLiveQuery(
        () => rollProposals(scope, localActorId),
        [inventoryScopeKey(scope), localActorId],
      ) ?? [],
    [refresh, setRefresh] = useState(0),
    [sending, setSending] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="min-w-0 space-y-3 break-words">
      {room === "coating" && (
        <CoatedRollOutput {...props} refreshToken={refresh} />
      )}
      <CoatedRollTransfers {...props} refreshToken={refresh} />
      <h4>Исходные действия с рулонами</h4>
      {proposals
        .filter((r) =>
          room === "coating"
            ? r.fields.kind !== "receipt"
            : r.fields.kind === "receipt",
        )
        .map((r) => (
          <article key={r.key} className={rollFrame}>
            <p>
              {r.operationId} ·{" "}
              {
                (
                  {
                    pending: "Ожидает отправки / исходного повтора",
                    accepted: "Сервер подтвердил действие с рулоном",
                    conflict: "Конфликт — исходное действие сохранено",
                    rejected: "Отклонено — требуется сверка",
                  } as Record<string, string>
                )[r.fields.state]
              }
            </p>
            {r.fields.state === "pending" && (
              <button
                className={button}
                disabled={sending}
                onClick={() => {
                  if (sending) return;
                  setSending(true);
                  setError("");
                  void sendRollCommand(session, scope, localActorId, r.key)
                    .then(() => setRefresh((n) => n + 1))
                    .catch((e) => setError(String(e)))
                    .finally(() => setSending(false));
                }}
              >
                Отправить исходное действие с рулоном{" "}
                {r.operationId?.slice(0, 8)}
              </button>
            )}
            <details>
              <summary className="min-h-11 py-2">
                Исходный запрос и ответ
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
