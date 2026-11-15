import React, { useEffect, useState } from 'react';
import { StageId, STAGE_LABELS } from '../../core/types';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import {
  planningApi, type Batch, type BatchStepRecord, type StepEvidenceKind,
} from '../../core/planning/planningClient';

const fieldClass = 'w-full rounded-lg border border-slate-600 bg-slate-900 p-2.5 text-sm text-white';
const buttonClass = 'rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40';
const labels: Record<StepEvidenceKind, string> = {
  started: 'Начало операции', completed: 'Завершение операции', deviation: 'Отклонение',
};

type Props = {
  connection: ServerConnection;
  batch: Pick<Batch, 'id' | 'status' | 'quantityUnit'>;
  onCompleted?: () => void;
};

/** Online-only, append-only evidence panel; never mirrors legacy local journals. */
export function StepEvidencePanel({ connection, batch, onCompleted }: Props) {
  const [records, setRecords] = useState<BatchStepRecord[]>([]);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [kind, setKind] = useState<StepEvidenceKind>('started');
  const [quantity, setQuantity] = useState('');
  const [equipmentCode, setEquipmentCode] = useState('');
  const [note, setNote] = useState('');
  const [eventId, setEventId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function currentSession() {
    return getServerConnection()?.session.accessToken === connection.session.accessToken;
  }
  async function fetchEvidence(signal?: AbortSignal) {
    const response = await planningApi.stepEvidence(connection, batch.id, signal);
    if (!Array.isArray(response.steps)) throw new Error('Сервер вернул неверный журнал операций');
    if (!signal?.aborted && currentSession()) setRecords(response.steps);
  }

  useEffect(() => {
    const controller = new AbortController();
    setRecords([]); setLoading(true); setError('');
    void fetchEvidence(controller.signal)
      .catch(reason => {
        if (controller.signal.aborted || !currentSession()) return;
        setRecords([]);
        const text = reason instanceof Error ? reason.message : 'Журнал недоступен';
        setError(text);
        if (text.startsWith('HTTP 401')) clearServerConnection();
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [connection.session.accessToken, batch.id]);

  const groups = Array.from(new Map(records.map(row => [
    row.number, { number: row.number, name: row.name, stage: row.stage, workshopId: row.workshopId },
  ])).values());
  const currentNumber = selectedNumber && groups.some(group => group.number === selectedNumber)
    ? selectedNumber : groups[0]?.number;
  const evidence = records.filter(row => row.number === currentNumber && row.evidence)
    .map(row => row.evidence!);
  const started = evidence.some(row => row.kind === 'started');
  const completed = evidence.some(row => row.kind === 'completed');
  const allowedKinds: StepEvidenceKind[] = !started ? ['started']
    : completed ? [] : ['completed', 'deviation'];
  const currentKind = allowedKinds.includes(kind) ? kind : allowedKinds[0];

  function changed() {
    // If a user edits a request after an unknown network outcome, its prior
    // ID must not silently acquire a different meaning on the next attempt.
    setEventId(crypto.randomUUID());
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!currentNumber || !currentKind || busy || batch.status !== 'in_progress' || !currentSession()) return;
    setBusy(true); setError(''); setMessage('');
    try {
      await planningApi.recordStepEvidence(connection, batch.id, currentNumber, {
        eventId, kind: currentKind,
        ...(currentKind === 'completed'
          ? { quantity: quantity.trim(), quantityUnit: batch.quantityUnit } : {}),
        ...(equipmentCode.trim() ? { equipmentCode: equipmentCode.trim() } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (!currentSession()) return;
      setEventId(crypto.randomUUID()); setQuantity(''); setEquipmentCode(''); setNote('');
      setMessage('Событие записано в неизменяемый журнал сервера');
      // A confirmed completion may unlock the next workshop handoff.
      // Refresh dependent read-only panels even when journal reload fails.
      if (currentKind === 'completed') onCompleted?.();
      try { await fetchEvidence(); }
      catch (cause) {
        setError('Запись сохранена, но обновление журнала не удалось: ' +
          (cause instanceof Error ? cause.message : 'ошибка связи'));
      }
    } catch (cause) {
      if (!currentSession()) return;
      const text = cause instanceof Error ? cause.message : 'Не удалось записать событие';
      setError(text);
      if (text.startsWith('HTTP 401')) clearServerConnection();
    } finally { setBusy(false); }
  }

  return <section className="space-y-3 rounded-lg border border-slate-700 p-3">
    <h4 className="font-medium text-white">Журнал выполнения операций маршрута</h4>
    <p className="text-xs text-slate-400">
      Здесь фиксируются подтверждения начала, завершения и отклонения операций.
      Это отдельный серверный журнал, не управление оборудованием и не списание со склада.
      Если ответ сервера потерялся, сначала обновите записи, не создавайте новую.
    </p>
    {loading && <p className="text-slate-400 text-sm" role="status">Загрузка операций…</p>}
    {error && <p className="text-sm text-red-200" role="alert">{error}</p>}
    {message && <p className="text-sm text-emerald-200" role="status">{message}</p>}
    {!loading && !groups.length &&
      <p className="text-amber-200 text-sm">Для данной ветки партии не найдены шаги утверждённого маршрута.</p>}
    {groups.map(group => {
      const stepEvents = records.filter(row => row.number === group.number && row.evidence)
        .map(row => row.evidence!);
      return <div key={group.number} className="rounded-md bg-slate-950/50 p-2 space-y-1">
        <p className="font-medium text-sm text-slate-200">
          {group.number}. {group.name} · {STAGE_LABELS[group.stage as StageId] ?? group.stage}
        </p>
        <p className="text-xs text-slate-400">{group.workshopId}</p>
        {!stepEvents.length && <p className="text-xs text-slate-500">Нет записей</p>}
        {stepEvents.map(entry => <p key={entry.id} className="text-xs text-slate-300">
          {labels[entry.kind]} · {new Date(entry.recordedAt).toLocaleString('ru-RU')}
          {entry.quantity && <> · {entry.quantity} {entry.quantityUnit}</>}
          {entry.equipmentCode && <> · {entry.equipmentCode}</>}
          {entry.note && <span className="block whitespace-pre-wrap text-slate-400">{entry.note}</span>}
        </p>)}
      </div>;
    })}
    {batch.status === 'in_progress' && groups.length > 0 &&
      <form className="space-y-2 border-t border-slate-700 pt-3" onSubmit={event => void submit(event)}>
        <label className="block text-xs text-slate-400">Шаг маршрута
          <select aria-label="Шаг маршрута" className={fieldClass + ' mt-1'}
            value={currentNumber ?? ''} onChange={event => {
              setSelectedNumber(Number(event.target.value)); setKind('started'); changed();
            }}>
            {groups.map(group => <option key={group.number} value={group.number}>
              {group.number}. {group.name}
            </option>)}
          </select>
        </label>
        {allowedKinds.length > 0 ? <>
          <label className="block text-xs text-slate-400">Тип записи
            <select aria-label="Тип записи операции" className={fieldClass + ' mt-1'}
              value={currentKind} onChange={event => {
                setKind(event.target.value as StepEvidenceKind); changed();
              }}>
              {allowedKinds.map(value => <option key={value} value={value}>{labels[value]}</option>)}
            </select>
          </label>
          {currentKind === 'completed' &&
            <label className="block text-xs text-slate-400">Зафиксированное количество ({batch.quantityUnit})
              <input aria-label="Зафиксированное количество" className={fieldClass + ' mt-1'}
                required inputMode="decimal" value={quantity} onChange={event => {
                  setQuantity(event.target.value); changed();
                }} placeholder="Например, 50" />
            </label>}
          <label className="block text-xs text-slate-400">Оборудование (необязательно)
            <input aria-label="Оборудование" className={fieldClass + ' mt-1'}
              maxLength={120} value={equipmentCode} onChange={event => {
                setEquipmentCode(event.target.value); changed();
              }} />
          </label>
          <label className="block text-xs text-slate-400">
            Примечание {currentKind === 'deviation' ? '(обязательно)' : '(необязательно)'}
            <textarea aria-label="Примечание к операции" className={fieldClass + ' mt-1'}
              rows={2} maxLength={2000} value={note} onChange={event => {
                setNote(event.target.value); changed();
              }} required={currentKind === 'deviation'} />
          </label>
          <button className={buttonClass} type="submit"
            disabled={busy || (currentKind === 'completed' && !quantity.trim()) ||
              (currentKind === 'deviation' && !note.trim())}>
            Записать событие
          </button>
        </> : <p className="text-slate-400 text-xs">Для этого шага уже зарегистрировано завершение.</p>}
      </form>}
  </section>;
}
