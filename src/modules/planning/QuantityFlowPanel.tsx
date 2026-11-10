import React, { useEffect, useState } from 'react';
import { clearServerConnection, getServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import { planningApi, type QuantityFlowStep } from '../../core/planning/planningClient';
import { metricLabels } from '../../core/planning/localSourceCandidates';

type Props = { connection: ServerConnection; batchId: string };

/** Declared route quantities, not physical inventory reconciliation. */
export function QuantityFlowPanel({ connection, batchId }: Props) {
  const [steps, setSteps] = useState<QuantityFlowStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function refresh(signal?: AbortSignal) {
    setLoading(true);
    setError('');
    try {
      const result = await planningApi.quantityFlow(connection, batchId, signal);
      if (!Array.isArray(result.steps)) throw new Error('Сервер вернул неверную сверку количеств');
      if (!signal?.aborted &&
          getServerConnection()?.session.accessToken === connection.session.accessToken)
        setSteps(result.steps);
    } catch (cause) {
      if (signal?.aborted) return;
      const message = cause instanceof Error ? cause.message : 'Не удалось получить сверку';
      setError(message);
      if (message.startsWith('HTTP 401')) clearServerConnection();
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    setSteps([]);
    void refresh(controller.signal);
    return () => controller.abort();
  }, [batchId, connection.session.accessToken]);

  return <section className="rounded-lg border border-slate-700 p-3 space-y-2">
    <div className="flex flex-wrap gap-2 items-center justify-between">
      <h4 className="font-medium text-white">Сверка количеств по маршруту</h4>
      <button type="button" onClick={() => void refresh()} disabled={loading}
        className="min-h-11 rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-200 disabled:opacity-40">
        Обновить сверку
      </button>
    </div>
    <p className="text-xs text-slate-400">
      Сравнение заявленного выхода операции и оформленной передачи.
      Разница — не подтверждённый брак, не потеря материала и не движение по складу.
      Значения обновляются по кнопке после новых записей.
    </p>
    <p className="text-xs text-slate-400">
      Локальная величина — снимок записи, вручную привязанный начальником.
      Совпадение величин не подтверждает качество, физический расход или приёмку.
      Сравнивается только одна величина выхода в тех же единицах; несколько записей не суммируются.
    </p>
    {loading && <p role="status" className="text-sm text-slate-400">Загрузка сверки…</p>}
    {error && <p role="alert" className="text-sm text-red-200">{error}</p>}
    {!loading && steps.length === 0 && !error &&
      <p className="text-sm text-slate-400">Для этой ветки маршрута нет этапов.</p>}
    <ol className="space-y-2">
      {steps.map(step => <li key={step.number}
        className="rounded-md border border-slate-700 bg-slate-950/40 p-2 space-y-1 text-sm">
        <p className="font-medium text-slate-200">{step.number}. {step.name} · {step.workshopId}</p>
        <p className="text-slate-300">
          Выход: {step.output ? step.output.quantity + ' ' + step.output.unit : 'ещё не подтверждён'}
        </p>
        <div className="border-t border-slate-700 pt-2 space-y-1">
          {step.sourceComparison?.source && <>
            <p className="text-slate-300 break-words">{step.sourceComparison.source.summary}</p>
            <p className="text-xs text-slate-400">
              {metricLabels[step.sourceComparison.source.measure.kind]}: {step.sourceComparison.source.measure.value}
            </p>
            <details className="text-xs text-slate-400 break-all">
              <summary className="min-h-11 cursor-pointer py-2">Идентификаторы исходной записи</summary>
              <p>Запись: {step.sourceComparison.source.sourceEntryId}</p>
              <p>Ссылка: {step.sourceComparison.source.linkId}</p>
            </details>
          </>}
          {step.sourceComparison?.status==='compared' && step.output &&
            <p className="text-xs text-amber-200">Заявленный выход минус локальная запись: {step.sourceComparison.difference} {step.output.unit}</p>}
          {step.sourceComparison?.status==='no_source' &&
            <p className="text-xs text-slate-400">Нет привязанной локальной величины.</p>}
          {step.sourceComparison?.status==='multiple_sources' &&
            <p className="text-xs text-amber-200">Несколько локальных величин ({step.sourceComparison.sourceCount}): сравнение не выполнено, записи могут пересекаться.</p>}
          {step.sourceComparison?.status==='reference_only' &&
            <p className="text-xs text-slate-400">Входной или частичный показатель: не сравнивается с выходом операции.</p>}
          {step.sourceComparison?.status==='output_missing' &&
            <p className="text-xs text-slate-400">Заявленный выход операции ещё не записан; сравнение недоступно.</p>}
          {step.sourceComparison?.status==='unit_mismatch' &&
            <p className="text-xs text-amber-200">Единицы измерения различаются; пересчёт и сравнение не выполняются.</p>}
          {!step.sourceComparison && <p className="text-xs text-slate-400">
            Сравнение с локальным журналом недоступно в этой версии сервера.
          </p>}
        </div>
        {step.nextStep === null ? <p className="text-xs text-slate-400">
          Финальный этап: межцеховая передача не требуется.
        </p> : step.handoff ? <>
          <p className="text-slate-300">
            Передано на этап {step.nextStep}: {step.handoff.quantity} {step.handoff.unit}
            {' · '}{step.handoff.received ? 'Приёмка подтверждена' : 'Приёмка ожидается'}
          </p>
          {step.difference !== null && step.output && <p className="text-xs text-amber-200">
            Выход минус передача: {step.difference} {step.output.unit} (причина не установлена)
          </p>}
        </> : <p className="text-xs text-slate-400">
          Передача на этап {step.nextStep} не зарегистрирована.
        </p>}
      </li>)}
    </ol>
  </section>;
}
