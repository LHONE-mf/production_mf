// Журнал работ комнаты этапа. Единая таблица для всех комнат,
// специфичные параметры — в JournalEntry.params.

import React, { useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../core/db';
import { StageId, JournalEntry } from '../../core/types';

interface Props {
  stage: StageId;
  canAdd: boolean;
  onAdd: (data: Omit<JournalEntry, 'id' | 'stage' | 'workerId' | 'createdAt'>) => Promise<void>;
}

export function StageJournal({ stage, canAdd, onAdd }: Props) {
  const entries = useLiveQuery(
    () => db.journal.where('stage').equals(stage).reverse().sortBy('createdAt'),
    [stage],
  );

  const [summary, setSummary] = useState('');
  const [paramsText, setParamsText] = useState(''); // "ключ=значение, ключ=значение"
  const [defects, setDefects] = useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [success,setSuccess]=useState('');
  const saving=useRef(false);

  // Supplemental notes only. Never parse decimal-comma notes into
  // authoritative measurements; those belong in validated room forms.
  const parseParams = (text: string): Record<string, string> | undefined => {
    if (!text.trim()) return undefined;
    const out: Record<string, string> = {};
    text.split(/[;\n]/).forEach(pair => {
      const separator=pair.indexOf('=');
      if(separator<0)return;
      const key=pair.slice(0,separator).trim();
      const value=pair.slice(separator+1).trim();
      if(key&&value)out[key]=value;
    });
    return Object.keys(out).length ? out : undefined;
  };

  const submit = async () => {
    if (!summary.trim() || saving.current) return;
    saving.current=true;setBusy(true);setError('');setSuccess('');
    try{
      await onAdd({ summary: summary.trim(), params: parseParams(paramsText), defects: defects.trim() });
      setSummary('');setParamsText('');setDefects('');
      setSuccess('Сохранено локально в журнале заметок. Это не измерение и не QA-допуск.');
    }catch(cause){
      setError(cause instanceof Error?cause.message:'Запись не сохранена. Проверьте хранилище и повторите.');
    }finally{saving.current=false;setBusy(false);}
  };

  return (
    <div className="space-y-3">
      {canAdd && (
        <div className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-2">
          <p className="text-sm font-semibold text-slate-200">Дополнительная запись журнала</p>
          <p className="text-xs text-slate-300">Здесь свободные заметки; измерения и результаты производства сохраняйте в специализированной форме участка. Параметры — текст, через ; или с новой строки.</p>
          <input
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500"
            placeholder="Что сделано (например: замес шлама партия 13, 240 кг)"
            value={summary} disabled={busy} onChange={(e) => {setSuccess('');setSummary(e.target.value);}}
          />
          <input
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500"
            placeholder="Заметки: Код=TEST-01; Значение=1,25"
            value={paramsText} disabled={busy} onChange={(e) => {setSuccess('');setParamsText(e.target.value);}}
          />
          <input
            className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500"
            placeholder="Дефекты / брак (если есть)"
            value={defects} disabled={busy} onChange={(e) => {setSuccess('');setDefects(e.target.value);}}
          />
          {error&&<p role="alert" className="text-sm text-red-200">{error}</p>}
          {success&&<p role="status" className="text-sm text-emerald-200">{success}</p>}
          <button
            type="button" onClick={()=>void submit()}
            disabled={busy||!summary.trim()}
            className="min-h-11 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm text-white font-medium"
          >
            {busy?'Сохранение…':'Записать заметку локально'}
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-slate-400 border-b border-slate-700">
              <th className="py-2 pr-3">Дата</th>
              <th className="py-2 pr-3">Работа</th>
              <th className="py-2 pr-3">Параметры</th>
              <th className="py-2">Дефекты</th>
            </tr>
          </thead>
          <tbody>
            {(entries ?? []).map((e) => (
              <tr key={e.id} className="border-b border-slate-800 text-slate-200">
                <td className="py-2 pr-3 text-xs whitespace-nowrap">{new Date(e.createdAt).toLocaleString('ru-RU')}</td>
                <td className="py-2 pr-3">{e.summary}</td>
                <td className="py-2 pr-3 text-xs text-slate-400">
                  {e.params ? Object.entries(e.params).map(([k, v]) => `${k}: ${v}`).join('; ') : '—'}
                </td>
                <td className={`py-2 text-xs ${e.defects ? 'text-red-400' : 'text-slate-500'}`}>
                  {e.defects || 'нет'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {entries?.length === 0 && <p className="text-slate-500 text-sm">Журнал пуст.</p>}
      </div>
    </div>
  );
}
