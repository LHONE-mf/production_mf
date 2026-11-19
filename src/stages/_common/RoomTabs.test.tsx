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

it('labels room navigation and exposes its selected section to assistive technology', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<RoomNavigationFixture />));
  const nav = host.querySelector('nav[aria-label="Разделы тестовой комнаты"]');
  expect(nav).not.toBeNull();
  const buttons = [...nav!.querySelectorAll('button')];
  expect(buttons).toHaveLength(3);
  expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
  await act(async () => buttons[1].click());
  expect(buttons.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false']);
});

it('keeps every room section discoverable and touch-sized on narrow screens', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<RoomNavigationFixture />));
  const nav = host.querySelector('nav')!;
  expect(nav.className).toContain('grid-cols-2');
  expect(nav.className).toContain('sm:flex');
  for (const button of nav.querySelectorAll('button')) {
    expect(button.className).toContain('min-h-11');
    expect(button.className).toContain('min-w-0');
    expect(button.type).toBe('button');
  }
});
