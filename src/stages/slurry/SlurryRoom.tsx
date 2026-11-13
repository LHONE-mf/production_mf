// Комната «Замесы» (slurry). Полностью офлайн: данные на устройстве,
// передача результатов — QR / текст (позже Bluetooth-mesh тем же форматом LIP:).
// Вкладки: Расчёт граммовок · База замесов · База компонентов · Журнал замеса · Комментарии · Задания.

import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../core/db';
import { listVisibleTasks } from '../../core/sync/visibleTasks';
import { MixRecipe, StageId, JournalEntry } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { CommentsSection } from '../_common/CommentsSection';
import { GrammageCalculator } from './GrammageCalculator';
import { RecipesDatabase } from './RecipesDatabase';
import { ComponentsDatabase } from './ComponentsDatabase';
import { MixBatchJournal } from './MixBatchJournal';
import { RoomWorkspaceHeader } from '../_common/RoomWorkspaceHeader';

type Tab = 'calc' | 'recipes' | 'components' | 'journal' | 'comments';

export function SlurryModule(){const actor=useAuthStore(s=>s.currentUser?.id);return <SlurryContent key={actor}/>;}
function SlurryContent() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const [tab, setTab] = useState<Tab>('calc');
  const [preset, setPreset] = useState<MixRecipe | null>(null);

  const tasks = useLiveQuery(
    async () => (await listVisibleTasks()).filter(task => task.stage === StageId.SLURRY)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
    [],
  );

  const tabs: { id: Tab; label: string }[] = [
    { id: 'calc', label: '⚖️ Новый замес' },
    { id: 'recipes', label: '📚 Рецепты' },
    { id: 'components', label: '🧱 Материалы' },
    { id: 'journal', label: '📒 Сохранённые замесы' },
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
      <RoomWorkspaceHeader icon="🧪" title="Комната замесов" description="Выберите сохранённый рецепт или создайте явный ручной план, внесите фактические навески, проверьте данные и сохраните замес. Плановые массы и оценки не являются измеренными результатами."/>

      <nav aria-label="Разделы комнаты замесов" className="flex flex-wrap gap-2 rounded-lg bg-slate-800 p-2 min-w-0">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button" aria-pressed={tab===t.id}
            onClick={() => setTab(t.id)}
            className={`min-h-11 px-3 py-2 rounded-md text-sm font-medium transition ${
              tab === t.id ? 'bg-blue-600 text-white' : 'text-slate-300 hover:bg-slate-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div hidden={tab!=='calc'}><GrammageCalculator presetRecipe={preset} onPresetConsumed={() => setPreset(null)}/></div>
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
