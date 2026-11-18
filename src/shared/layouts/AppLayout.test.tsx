import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { UserRole } from '../../core/types';
import { AppLayout } from './AppLayout';

const profile = { id: 'local-test', role: UserRole.CHIEF, fullName: 'Test User' };
vi.mock('../../core/store/authStore', () => ({
  useAuthStore: () => ({ currentUser: profile, logout: vi.fn() }),
}));
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => [] }));
vi.mock('../../core/sync/visibleTasks', () => ({ listVisibleTasks: vi.fn() }));
vi.mock('../../core/sync/offlineTaskLease', () => ({
  requireOfflineTaskEditLease: vi.fn(),
  clearOfflineTaskEditLease: vi.fn(),
}));
vi.mock('../../core/sync/serverConnection', () => ({ clearServerConnection: vi.fn() }));
vi.mock('../../stages/registry', () => ({ STAGES: [] }));

let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  vi.unstubAllGlobals();
});

it('labels mobile navigation, focuses its close control and restores focus on Escape', async () => {
  await act(async () => root.render(
    <AppLayout activeTab="dashboard" onTabChange={vi.fn()}><p>Content</p></AppLayout>,
  ));
  const opener = node.querySelector<HTMLButtonElement>('button[aria-label="Открыть меню"]')!;
  expect(opener.getAttribute('aria-expanded')).toBe('false');
  expect(node.querySelector('button[aria-current="page"]')?.textContent).toContain('Дашборд');
  await act(async () => opener.click());
  const menuId = opener.getAttribute('aria-controls')!;
  const close = node.querySelector<HTMLButtonElement>('button[aria-label="Закрыть меню"]')!;
  expect(document.getElementById(menuId)).not.toBeNull();
  expect(opener.getAttribute('aria-expanded')).toBe('true');
  expect(document.activeElement).toBe(close);
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  expect(opener.getAttribute('aria-expanded')).toBe('false');
  expect(document.getElementById(menuId)).toBeNull();
  expect(document.activeElement).toBe(opener);
});
