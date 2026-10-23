// Комната «Замесы» (slurry). Полностью офлайн: данные на устройстве,
// передача результатов — QR / текст (позже Bluetooth-mesh тем же форматом LIP:).
// Вкладки: Расчёт граммовок · База замесов · База компонентов · Журнал замеса · Комментарии · Задания.

import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { MixRecipe, StageId, JournalEntry } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { GrammageCalculator } from './GrammageCalculator';
import { RecipesDatabase } from './RecipesDatabase';
import { ComponentsDatabase } from './ComponentsDatabase';
import { MixBatchJournal } from './MixBatchJournal';

type Tab = 'calc' | 'recipes' | 'components' | 'journal' | 'comments';

export function SlurryModule() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [tab, setTab] = useState<Tab>('calc');
  const [preset, setPreset] = useState<MixRecipe | null>(null);

  const tasks = useLiveQuery(
    () => db.tasks.where('stage').equals(StageId.SLURRY).reverse().sortBy('updatedAt'),
    [],
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: 'calc', label: '⚖️ Расчёт граммовок' },
    { id: 'recipes', label: '📚 База замесов' },
    { id: 'components', label: '🧱 База компонентов' },
    { id: 'journal', label: '📒 Журнал замеса' },
    { id: 'comments', label: '💬 Комментарии' },
  ];

  const addComment = async (text: string) => {
    if (!currentUser || !text.trim()) return;
    await db.stageComments.add({
      id: uuidv4(), stage: StageId.SLURRY, authorId: currentUser.id, text: text.trim(), createdAt: new Date(),
    });
  };

  const useRecipe = (r: MixRecipe) => {
    setPreset(r);
    setTab('calc');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">🧪 Комната замесов</h2>
        <span className="text-xs text-slate-400">Офлайн · данные на устройстве</span>
      </div>

      <div className="flex gap-1 bg-slate-800 rounded-lg p-1 w-fit flex-wrap">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-3 py-1.5 rounded-md text-sm transition ${
              tab === t.id ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'calc' && <GrammageCalculator presetRecipe={preset} onPresetConsumed={() => setPreset(null)} />}
      {tab === 'recipes' && <RecipesDatabase onUse={useRecipe} />}
      {tab === 'components' && <ComponentsDatabase />}
      {tab === 'journal' && <MixBatchJournal />}
      {tab === 'comments' && <CommentsSection stage={StageId.SLURRY} onAdd={addComment} />}

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
          {tasks?.length === 0 && <p className="text-slate-500 text-sm">Заданий по этому этапу пока нет.</p>}
        </div>
      </div>
    </div>
  );
}
