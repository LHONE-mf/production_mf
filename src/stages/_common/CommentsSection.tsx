// Секция комментариев комнаты этапа (общая для всех ролей комнаты).

import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../core/db';
import { StageId } from '../../core/types';

interface Props {
  stage: StageId;
  onAdd: (text: string) => Promise<void>;
}

export function CommentsSection({ stage, onAdd }: Props) {
  const comments = useLiveQuery(
    () => db.stageComments.where('stage').equals(stage).reverse().sortBy('createdAt'),
    [stage],
  );
  const users = useLiveQuery(() => db.users.toArray(), []);
  const [text, setText] = useState('');

  const authorName = (id: string) => users?.find((u) => u.id === id)?.fullName ?? 'Неизвестный';

  const submit = async () => {
    if (!text.trim()) return;
    await onAdd(text);
    setText('');
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <textarea
          className="flex-1 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 resize-none"
          rows={2}
          placeholder="Заметка для комнаты (технолог, мастер и работники увидят её)"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          onClick={submit}
          disabled={!text.trim()}
          className="self-end px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded text-sm text-white font-medium h-fit"
        >
          Отправить
        </button>
      </div>

      <div className="space-y-2">
        {(comments ?? []).map((c) => (
          <div key={c.id} className="bg-slate-800 border border-slate-700 rounded-lg p-3">
            <div className="flex justify-between items-center mb-1">
              <span className="text-xs font-semibold text-blue-300">{authorName(c.authorId)}</span>
              <span className="text-xs text-slate-500">{new Date(c.createdAt).toLocaleString('ru-RU')}</span>
            </div>
            <p className="text-sm text-slate-200">{c.text}</p>
          </div>
        ))}
        {comments?.length === 0 && <p className="text-slate-500 text-sm">Комментариев пока нет.</p>}
      </div>
    </div>
  );
}
