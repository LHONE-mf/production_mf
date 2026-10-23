// Общий каркас «комнаты» этапа производства.
// Каждая комната = StageRoom + свой инструмент (prop `tool`).
// Стандартный состав: инструмент, журнал работ, комментарии, задания этапа.

import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { StageId, JournalEntry } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { StageJournal } from './StageJournal';
import { CommentsSection } from './CommentsSection';

interface Props {
  stage: StageId;
  title: string;
  icon?: string;
  /** Специфичный инструмент комнаты (калькулятор, параметры и т.п.) */
  tool?: React.ReactNode;
}

export function StageRoom({ stage, title, icon, tool }: Props) {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [tab, setTab] = useState<'tool' | 'journal' | 'comments'>('tool');

  const tasks = useLiveQuery(
    () => db.tasks.where('stage').equals(stage).reverse().sortBy('updatedAt'),
    [stage],
  );

  const tabs = [
    ...(tool ? [{ id: 'tool' as const, label: 'Инструмент' }] : []),
    { id: 'journal' as const, label: 'Журнал работ' },
    { id: 'comments' as const, label: 'Комментарии' },
  ];
  const activeTab = tabs.some((t) => t.id === tab) ? tab : tabs[0].id;

  const addJournalEntry = async (data: Omit<JournalEntry, 'id' | 'stage' | 'workerId' | 'createdAt'>) => {
    if (!currentUser) return;
    await db.journal.add({
      id: uuidv4(), stage, workerId: currentUser.id, createdAt: new Date(), ...data,
    });
  };

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage, authorId: currentUser.id, text: text.trim(), createdAt: new Date(),
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          {icon && <span>{icon}</span>} {title}
        </h2>
        <span className="text-xs text-slate-400">Офлайн · данные на устройстве</span>
      </div>

      {/* Вкладки комнаты */}
      <div className="flex gap-1 bg-slate-800 rounded-lg p-1 w-fit">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-md text-sm transition ${
              activeTab === t.id ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === 'tool' && tool}

      {activeTab === 'journal' && (
        <StageJournal stage={stage} onAdd={addJournalEntry} canAdd={!!currentUser} />
      )}

      {activeTab === 'comments' && <CommentsSection stage={stage} onAdd={addComment} />}

      {/* Задания этапа */}
      <div>
        <h3 className="text-sm font-semibold text-slate-300 mb-2">Задания этапа ({tasks?.length ?? 0})</h3>
        <div className="space-y-2">
          {(tasks ?? []).slice(0, 5).map((t) => (
            <div key={t.id} className="bg-slate-800 rounded-lg p-3 border border-slate-700">
              <div className="flex justify-between items-start">
                <p className="text-white text-sm font-medium">{t.title}</p>
                <span className="text-xs text-slate-400">{new Date(t.updatedAt).toLocaleDateString('ru-RU')}</span>
              </div>
              <p className="text-slate-400 text-xs mt-1">{t.description}</p>
            </div>
          ))}
          {tasks?.length === 0 && (
            <p className="text-slate-500 text-sm">Заданий по этому этапу пока нет.</p>
          )}
        </div>
      </div>
    </div>
  );
}
