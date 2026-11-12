import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { db } from '../core/db';
import { useAuthStore } from '../core/store/authStore';
import { TaskPriority, TaskStatus, UserRole, type AssemblyRun, type FormationRun } from '../core/types';
import { KpiDashboard } from './KpiDashboard';
import { ReportsModule } from '../modules/reports/ReportsModule';
import { provisionOfflineTaskEditLease, clearOfflineTaskEditLease } from '../core/sync/offlineTaskLease';
let node: HTMLDivElement, root: Root;
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
function assembly(id: string, cellsOut: number, days = 1): AssemblyRun {
  return { id, batchName: id, cellType: 'unassigned', ops: [], cellsOut, cellsScrap: 0, defects: [], workerId: 'operator', createdAt: ago(days), updatedAt: ago(days) };
}
function formation(id: string, cellsOut: unknown, days = 1): FormationRun {
  // Deliberately retains malformed historical fields, without rewriting the DB.
  return { id, batchName: id, mode: { cycles: 5 }, cellsIn: 20, cellsOut, cellsScrap: 0, defects: [], workerId: 'operator', startDate: ago(days).slice(0,10), createdAt: ago(days), updatedAt: ago(days) } as FormationRun;
}
const card = (label: string) => [...node.querySelectorAll('p')].find(p => p.textContent === label)?.parentElement;
const value = (label: string) => card(label)?.querySelectorAll('p')[1]?.textContent;
async function render(view = <KpiDashboard />) {
  await act(async () => root.render(view));
  await vi.waitFor(() => expect(node.textContent).not.toMatch(/Загрузка KPI|Читаем локальные записи/));
}
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); await db.open();
  useAuthStore.getState().login({ id: 'chief', login: 'chief', fullName: 'TEST chief', password: 'TEST-only', role: UserRole.CHIEF, isActive: true, createdAt: new Date() });
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); useAuthStore.getState().logout(); db.close(); await db.delete(); localStorage.clear(); vi.unstubAllGlobals(); });

it('never computes yield from unrelated assembly and formation lots', async () => {
  await db.assemblyRuns.add(assembly('lot-A', 2)); await db.formationRuns.add(formation('unrelated-lot-B', 10));
  await render();
  expect(value('Собрано ячеек')).toBe('2'); expect(value('После формировки')).toBe('10');
  expect(value('Годность цепочки')).toBe('—'); expect(card('Годность цепочки')?.textContent).toContain('связь партий');
  expect(node.textContent).not.toContain('500.0%'); expect(node.textContent).not.toContain('формировка / сборка');
});

it('distinguishes no observation, explicit zero and partial historical totals while refreshing live', async () => {
  await render(); expect(value('После формировки')).toBe('—'); expect(value('Замешано пасты')).toBe('—');
  await act(async () => db.formationRuns.add(formation('zero', 0)));
  await vi.waitFor(() => expect(value('После формировки')).toBe('0'));
  await act(async () => db.formationRuns.bulkAdd([formation('missing', undefined), formation('blank', ''), formation('null', null), formation('bad', NaN)]));
  await vi.waitFor(() => expect(value('После формировки')).toBe('0 + ?'));
  expect(card('После формировки')?.textContent).toContain('без значения: 4');
  expect((await db.formationRuns.get('blank'))?.cellsOut).toBe('');
  await act(async () => db.formationRuns.update('zero', { cellsOut: 3 }));
  await vi.waitFor(() => expect(value('После формировки')).toBe('3 + ?'));
  // A newly saved observation must appear immediately, even after mount time.
  await act(async () => db.formationRuns.add(formation('just-saved', 2, 0)));
  await vi.waitFor(() => expect(value('После формировки')).toBe('5 + ?'));
});

it('uses observation dates, separates date windows, and excludes invalid/future dates without inventing zero', async () => {
  const declaration = { ...assembly('old-job-new-output', 999, 60), operationLedger: 1 as const,
    cellOutput: { id: 'out', operationId: 'op', count: 4, cellType: 'cylindrical' as const, serialRange: { start: 1, end: 4 }, recordedBy: 'operator', recordedRole: UserRole.MASTER, recordedAt: ago(1), note: 'Count only' } };
  await db.assemblyRuns.bulkAdd([declaration, { ...assembly('intake-without-output', 999), operationLedger: 1 }]);
  await db.formationRuns.bulkAdd([formation('recent', 2), formation('older', 7, 20), { ...formation('undated', 50), createdAt: 'unknown' }, formation('future', 50, -1)]);
  await render(); expect(value('После формировки')).toBe('2'); expect(value('Собрано ячеек')).toBe('4 + ?');
  await act(async () => [...node.querySelectorAll('button')].find(b => b.textContent === '30 дней')!.click());
  expect(value('После формировки')).toBe('9');
  await act(async () => [...node.querySelectorAll('button')].find(b => b.textContent === 'Всё время')!.click());
  expect(value('После формировки')).toBe('9'); expect(node.textContent).toContain('неверной датой');
});

it('keeps server-owned task counts hidden without a current offline grant', async () => {
  const taskId='11111111-1111-4111-8111-111111111111', actorId='22222222-2222-4222-8222-222222222222';
  await db.tasks.add({ id: taskId, title: 'Confidential', description: '', assignedTo: actorId, createdBy: actorId, status: TaskStatus.CREATED, priority: TaskPriority.MEDIUM, createdAt: new Date(), updatedAt: new Date(), comments: [], attachments: [] });
  await db.hybridTaskRevisions.put({ entityId: taskId, revision: 1 });
  await render(); expect(value('Открытые задания')).toBe('0');
  await act(async()=>provisionOfflineTaskEditLease({deviceId:'33333333-3333-4333-8333-333333333333',organizationId:'44444444-4444-4444-8444-444444444444',actorId,role:'chief',expiresAt:Date.now()+60_000,authorizedTaskIds:[taskId]}));
  await vi.waitFor(()=>expect(value('Открытые задания')).toBe('1'));
  await act(async()=>clearOfflineTaskEditLease());
  await vi.waitFor(()=>expect(value('Открытые задания')).toBe('0'));
  await act(async () => db.tasks.add({ id: 'local-task', title: 'TEST local', description: '', assignedTo: 'chief', createdBy: 'chief', status: TaskStatus.CREATED, priority: TaskPriority.MEDIUM, createdAt: new Date(), updatedAt: new Date(), comments: [], attachments: [] }));
  await vi.waitFor(() => expect(value('Открытые задания')).toBe('1'));
});

it('reports unknown/blank legacy output as unavailable and updates an explicit zero without coercion', async () => {
  await db.formationRuns.bulkAdd([formation('missing', undefined), formation('blank', '')]);
  await render(<ReportsModule />); expect(value('Заявленный выход формовки, шт.')).toBe('—');
  await act(async () => db.formationRuns.add(formation('zero', 0)));
  await vi.waitFor(() => expect(value('Заявленный выход формовки, шт.')).toBe('0 + ?'));
  expect(node.textContent).toContain('без значения: 2');
  expect((await db.formationRuns.get('blank'))?.cellsOut).toBe('');
});
