import { RoomTabs } from '../_common/RoomTabs';
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
import {RoomCustody} from '../_common/RoomCustody';
import {SlurryMaterials} from './SlurryMaterials';

type Tab = 'calc' | 'recipes' | 'components' | 'journal' | 'comments' | 'materials' | 'custody';

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
    { id: 'journal', label: '📒 Сохранённые замесы' },
    { id: 'custody', label: '🔁 Выпуск и передача' },
    { id: 'materials', label: '📦 Остатки и расход' },
    { id: 'recipes', label: '📚 Рецепты' },
    { id: 'components', label: '🧱 Материалы' },
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

      <RoomTabs label="Разделы комнаты замесов" tabs={tabs} activeTab={tab} onChange={setTab} />

      <div hidden={tab!=='calc'}><GrammageCalculator presetRecipe={preset} onPresetConsumed={() => setPreset(null)}/></div>
      {tab === 'recipes' && <RecipesDatabase onUse={useRecipe} />}
      {tab === 'components' && <ComponentsDatabase />}
      {tab === 'journal' && <MixBatchJournal />}
      {tab === 'custody' && <RoomCustody room="slurry"/>}
      {tab === 'materials' && <SlurryMaterials/>}
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
