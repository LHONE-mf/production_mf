import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { RoomTabs } from './RoomTabs';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  vi.unstubAllGlobals();
});

function RoomNavigationFixture() {
  const [active, setActive] = useState<'incoming' | 'journal' | 'comments'>('incoming');
  return <RoomTabs
    label="Разделы тестовой комнаты"
    activeTab={active}
    onChange={setActive}
    tabs={[
      { id: 'incoming', label: '📥 Партии с производственной линии' },
      { id: 'journal', label: 'Журнал измерений и результатов' },
      { id: 'comments', label: 'Комментарии' },
    ]}
  />;
}

async function render() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<RoomNavigationFixture />));
  return host.querySelector('nav[aria-label="Разделы тестовой комнаты"]')!;
}

it('switches a shared room section through the native picker or a desktop button', async () => {
  const nav = await render();
  const select = nav.querySelector('select')!;
  const buttons = [...nav.querySelectorAll('button')];
  expect(buttons).toHaveLength(3);
  expect(select.value).toBe('incoming');
  expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
  await act(async () => {
    select.value = 'journal';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  expect(select.value).toBe('journal');
  expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
  await act(async () => buttons[2].click());
  expect(select.value).toBe('comments');
});

it('makes all sections accessible in one touch-sized control on phones', async () => {
  const nav = await render();
  expect(nav.className).not.toContain('grid-cols-2');
  const select = nav.querySelector('select')!;
  expect(select.getAttribute('aria-label')).toBe('Разделы тестовой комнаты');
  expect(select.className).toContain('min-h-11');
  expect(select.className).toContain('min-w-0');
  expect(select.closest('label')?.className).toContain('sm:hidden');
  expect([...select.options].map(option => option.textContent)).toEqual([
    '📥 Партии с производственной линии', 'Журнал измерений и результатов', 'Комментарии',
  ]);
  for (const button of nav.querySelectorAll('button')) {
    expect(button.className).toContain('min-h-11');
    expect(button.type).toBe('button');
  }
});
