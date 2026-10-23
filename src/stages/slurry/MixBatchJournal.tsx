// Журнал замеса — фактические результаты (навески, вязкость, перетир).
// Slave-устройство (работник) отправляет запись master'у офлайн: QR / текст (позже Bluetooth).
// Master может принять запись или дописать свою пометку (forced-push).

import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../../core/db';
import { MixBatch, StageId, SyncPacket, UserRole } from '../../core/types';
import { useAuthStore } from '../../core/store/authStore';
import { PacketOutModal } from './_ui/PacketOutModal';

export function MixBatchJournal() {
  const currentUser = useAuthStore((s) => s.currentUser);
  const isManager = !!currentUser && [UserRole.MASTER, UserRole.CHIEF].includes(currentUser.role);

  const batches = useLiveQuery(() => db.mixBatches.orderBy('createdAt').reverse().toArray(), []);
  const components = useLiveQuery(() => db.mixComponents.toArray(), []);
  const users = useLiveQuery(() => db.users.toArray(), []);
  const compName = (id: string) => components?.find((c) => c.id === id)?.name ?? id;
  const userName = (id: string) => users?.find((u) => u.id === id)?.fullName ?? id;

  const [openId, setOpenId] = useState<string | null>(null);
  const [outPacket, setOutPacket] = useState<SyncPacket | null>(null);

  const send = async (b: MixBatch, forced = false) => {
    if (!currentUser) return;
    // перед отправкой освежаем updatedAt — принимающая сторона сравнивает по нему
    const fresh = { ...b, updatedAt: Date.now() };
    await db.mixBatches.put(fresh);
    setOutPacket({
      v: 1, type: forced ? 'forced-push' : 'mix-batch', stage: StageId.SLURRY,
      payload: fresh, from: currentUser.id, ts: Date.now(), forced: forced || undefined,
    });
  };

  return (
    <div className="space-y-3">
      <h3 className="text-white font-semibold">📒 Журнал замеса</h3>
      <p className="text-xs text-slate-500">
        Фактические навески, вязкость и степень перетира. Отправка результатов мастеру/начальнику —
        офлайн (QR/текст, позже Bluetooth). Принудительная допись (⚡) доступна мастеру и начальнику.
      </p>

      <div className="space-y-2">
        {(batches ?? []).map((b) => {
          const open = openId === b.id;
          const totalPlanned = b.weighings.reduce((s, w) => s + w.plannedG, 0);
          const totalActual = b.weighings.reduce((s, w) => s + w.actualG, 0);
          return (
            <div key={b.id} className="bg-slate-800 border border-slate-700 rounded-lg p-3 space-y-2">
              <button className="w-full text-left" onClick={() => setOpenId(open ? null : b.id)}>
                <div className="flex items-center justify-between flex-wrap gap-1">
                  <p className="text-white text-sm font-medium">
                    {b.recipeName} <span className="text-slate-400 text-xs">· СВ {b.batchKg} кг · {userName(b.workerId)}</span>
                  </p>
                  <span className="text-xs text-slate-500">{new Date(b.createdAt).toLocaleString('ru-RU')}</span>
                </div>
                <div className="flex gap-3 text-xs mt-1">
                  <span className={b.viscosity ? 'text-slate-300' : 'text-slate-600'}>Вязкость: {b.viscosity ?? '—'}</span>
                  <span className={b.fineness ? 'text-slate-300' : 'text-slate-600'}>Перетир: {b.fineness != null ? `${b.fineness} мкм` : '—'}</span>
                  <span className="text-slate-500">{open ? '▲ свернуть' : '▼ открыть детали'}</span>
                </div>
              </button>

              {open && (
                <div className="border-t border-slate-700 pt-2 space-y-2">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-400 border-b border-slate-700">
                        <th className="py-1 pr-2">Компонент</th>
                        <th className="py-1 pr-2 text-right">Расчёт, г</th>
                        <th className="py-1 pr-2 text-right">Факт, г</th>
                        <th className="py-1 text-right">Δ, г</th>
                      </tr>
                    </thead>
                    <tbody>
                      {b.weighings.map((w) => {
                        const d = w.actualG - w.plannedG;
                        return (
                          <tr key={w.componentId} className="border-b border-slate-800 text-slate-200">
                            <td className="py-1 pr-2">{compName(w.componentId)}</td>
                            <td className="py-1 pr-2 text-right font-mono">{w.plannedG.toLocaleString('ru-RU')}</td>
                            <td className="py-1 pr-2 text-right font-mono">{w.actualG.toLocaleString('ru-RU')}</td>
                            <td className={`py-1 text-right font-mono ${Math.abs(d) > w.plannedG * 0.01 ? 'text-red-400' : 'text-slate-400'}`}>
                              {d >= 0 ? '+' : ''}{d.toLocaleString('ru-RU')}
                            </td>
                          </tr>
                        );
                      })}
                      <tr className="text-slate-300 font-semibold">
                        <td className="py-1 pr-2">Итого</td>
                        <td className="py-1 pr-2 text-right font-mono">{totalPlanned.toLocaleString('ru-RU')}</td>
                        <td className="py-1 pr-2 text-right font-mono">{totalActual.toLocaleString('ru-RU')}</td>
                        <td className="py-1 text-right font-mono">{(totalActual - totalPlanned >= 0 ? '+' : '') + (totalActual - totalPlanned).toLocaleString('ru-RU')}</td>
                      </tr>
                    </tbody>
                  </table>

                  {b.modeActual && b.modeActual.length > 0 && (
                    <div className="text-xs text-slate-400 space-y-0.5">
                      <p className="font-semibold text-slate-300">Фактический режим:</p>
                      {b.modeActual.map((s, i) => (
                        <p key={s.id}>{i + 1}. {s.name}: {s.disperserRpm ?? '—'}/{s.paddleRpm ?? '—'} об/мин
                          {s.vacuumOn ? `, вакуум ${s.vacuumKpa ?? '?'} кПа` : ''}, {s.tempC ?? '—'}°C, {s.minutes} мин</p>
                      ))}
                    </div>
                  )}
                  {b.notes && <p className="text-xs text-red-300">Замечания: {b.notes}</p>}

                  <div className="flex gap-2 flex-wrap">
                    <button onClick={() => send(b)} className="text-xs px-3 py-1.5 bg-green-700 hover:bg-green-600 rounded text-white font-medium">
                      📡 Отправить результат (slave → master)
                    </button>
                    {isManager && (
                      <button onClick={() => send(b, true)} title="Принудительно дописать во все slave"
                        className="text-xs px-3 py-1.5 bg-orange-800/70 hover:bg-orange-700 rounded text-white font-medium">
                        ⚡ Forced-push всем
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
        {batches?.length === 0 && <p className="text-slate-500 text-sm">Журнал замеса пуст. Запишите результат в «Расчёте граммовок».</p>}
      </div>

      {outPacket && <PacketOutModal packet={outPacket} onClose={() => setOutPacket(null)} />}
    </div>
  );
}
