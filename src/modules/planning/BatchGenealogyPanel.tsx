import React, { useEffect, useState, type FormEvent } from 'react';
import {
  planningApi, type Batch, type BatchGenealogyLink, type GenealogyKind,
} from '../../core/planning/planningClient';

type Declaration = Parameters<typeof planningApi.declareGenealogy>[2];

interface Props {
  batch: Batch;
  orderBatches: Batch[];
  links: BatchGenealogyLink[];
  busy: boolean;
  /** Returns true only after the server confirms the declaration. */
  onDeclare: (declaration: Declaration) => Promise<boolean>;
}

const kindNames: Record<GenealogyKind, string> = {
  assembly: 'Комплектование ячейки',
  split: 'Разделение партии',
  merge: 'Объединение партий',
  consumption: 'Связь с использованным материалом',
};
const decimal = /^(?=.*[1-9])(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,6})?$/;

export function eligibleGenealogySources(
  target: Batch, batches: Batch[], kind: GenealogyKind,
): Batch[] {
  return batches.filter(source => source.id !== target.id && source.status === 'completed' &&
    (kind === 'assembly'
      ? target.materialLine === 'cell' &&
        (source.materialLine === 'anode' || source.materialLine === 'cathode')
      : (kind === 'split' || kind === 'merge')
        ? source.materialLine === target.materialLine
        : true));
}

/** Only direct provenance declarations. This does not book stock or mass balance. */
export function BatchGenealogyPanel({ batch, orderBatches, links, busy, onDeclare }: Props) {
  const [kind, setKind] = useState<GenealogyKind>('assembly');
  const [sourceId, setSourceId] = useState('');
  const [sourceQuantity, setSourceQuantity] = useState('');
  const [targetQuantity, setTargetQuantity] = useState('');
  const [note, setNote] = useState('');

  // The form must not reuse quantities or source from another batch's screen.
  useEffect(() => {
    setSourceId(''); setSourceQuantity(''); setTargetQuantity(''); setNote('');
    setKind('assembly');
  }, [batch.id]);

  const candidates = eligibleGenealogySources(batch, orderBatches, kind);
  const source = candidates.find(candidate => candidate.id === sourceId);
  const targetOpen = batch.status === 'created' || batch.status === 'in_progress';
  const valid = targetOpen && source && decimal.test(sourceQuantity) &&
    decimal.test(targetQuantity) && !busy;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!source || !valid) return;
    const saved = await onDeclare({
      sourceBatchId: source.id, kind,
      sourceQuantity, sourceUnit: source.quantityUnit,
      targetQuantity, targetUnit: batch.quantityUnit,
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    if (saved) {
      setSourceId(''); setSourceQuantity(''); setTargetQuantity(''); setNote('');
    }
  }

  return <div className="space-y-3 rounded-lg border border-slate-700 p-3">
    <h4 className="font-semibold text-white">Происхождение и связи партии</h4>
    <p className="text-xs text-slate-400">
      Только прямые связи с другими партиями этого заказа.
      Декларация не списывает материалы, не рассчитывает выход и не заменяет
      документированный факт производства.
    </p>
    {!links.length && <p className="text-sm text-slate-400">Связей пока нет.</p>}
    <ol className="space-y-2">
      {links.map(link => <li key={link.id}
        className="rounded-lg border-l-2 border-violet-500 bg-slate-950/40 p-2 text-sm text-slate-300">
        <div className="font-medium text-slate-100">
          {link.sourceCode} → {link.targetCode}
        </div>
        <div>{kindNames[link.kind]} · {link.sourceQuantity} {link.sourceUnit} →
          {' '}{link.targetQuantity} {link.targetUnit}</div>
        <p className="text-xs text-slate-400">
          {link.sourceBatchId === batch.id ? 'Исходящая связь' : 'Входящая связь'}
          {' · '}{new Date(link.occurredAt).toLocaleString('ru-RU')}
        </p>
        {link.note && <p className="mt-1 whitespace-pre-wrap text-xs text-slate-400">{link.note}</p>}
      </li>)}
    </ol>
    {targetOpen ? <form className="space-y-3 border-t border-slate-700 pt-3"
      onSubmit={event => void submit(event)}>
      <h5 className="font-medium text-white">Добавить связь к этой партии</h5>
      <label className="block text-xs text-slate-400">Тип связи
        <select aria-label="Тип связи партий"
          className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 p-2.5 text-sm text-white"
          value={kind} onChange={event => { setKind(event.target.value as GenealogyKind); setSourceId(''); }}>
          {Object.entries(kindNames).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
      </label>
      <label className="block text-xs text-slate-400">Исходная партия (только завершённые)
        <select aria-label="Исходная партия"
          className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 p-2.5 text-sm text-white"
          value={sourceId} required
          onChange={event => setSourceId(event.target.value)}>
          <option value="">Выберите исходную партию</option>
          {candidates.map(candidate => <option key={candidate.id} value={candidate.id}>
            {candidate.batchCode} ({candidate.materialLine})
          </option>)}
        </select>
      </label>
      {!candidates.length && <p className="text-xs text-amber-300">
        Для выбранного типа связи нет подходящей завершённой исходной партии.
      </p>}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="block text-xs text-slate-400">Количество исходной партии ({source?.quantityUnit ?? '—'})
          <input aria-label="Количество исходной партии" required inputMode="decimal"
            className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 p-2.5 text-sm text-white"
            value={sourceQuantity} onChange={event => setSourceQuantity(event.target.value)}
            placeholder="Например: 2.500000" />
        </label>
        <label className="block text-xs text-slate-400">Количество целевой партии ({batch.quantityUnit})
          <input aria-label="Количество целевой партии" required inputMode="decimal"
            className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 p-2.5 text-sm text-white"
            value={targetQuantity} onChange={event => setTargetQuantity(event.target.value)}
            placeholder="Например: 100" />
        </label>
      </div>
      <label className="block text-xs text-slate-400">Примечание / документ-основание
        <textarea aria-label="Примечание к связи" rows={2} maxLength={2000}
          className="mt-1 w-full rounded-lg border border-slate-600 bg-slate-900 p-2.5 text-sm text-white"
          value={note} onChange={event => setNote(event.target.value)} />
      </label>
      <button type="submit" disabled={!valid}
        className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40">
        Записать связь на сервере
      </button>
    </form> : <p className="text-sm text-slate-400">
      Для остановленной, завершённой или списанной целевой партии новые связи не создаются.
    </p>}
  </div>;
}
