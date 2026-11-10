import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearServerConnection, setServerConnection } from '../../core/sync/serverConnection';
import { PlanningModule } from './PlanningModule';

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function renderPlanning() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<PlanningModule onOpenSync={() => {}} />);
    await Promise.resolve();
  });
  return container;
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  container?.remove();
  container = undefined;
  clearServerConnection();
  vi.unstubAllGlobals();
});

describe('M2 online planning screen', () => {
  it('does not reveal server planning records without a verified server login', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const app = await renderPlanning();
    expect(app.textContent).toContain('Для просмотра производственных заказов');
    expect(app.textContent).toContain('Локальный демонстрационный вход');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('presents chief-only order controls after reading tenant-scoped server data', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/planning/workshops') ? { workshops: [] }
        : url.endsWith('/planning/routes') ? { routes: [] }
        : { orders: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    setServerConnection({
      session: { serverUrl: 'https://mes.example.org', accessToken: 'chief-token' },
      serverUrl: 'https://mes.example.org', organizationId: 'org',
      serverRole: 'chief', serverActorId: 'chief', selectedDeviceId: '',
      enrolledDeviceId: '', myDevices: [],
    });
    const app = await renderPlanning();
    expect(app.textContent).toContain('Новый производственный заказ');
    expect(app.textContent).toContain('Утверждённый маршрут');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/orders',
      expect.objectContaining({ headers: expect.objectContaining({
        Authorization: 'Bearer chief-token',
      }) }),
    );
    const button = Array.from(app.querySelectorAll('button'))
      .find(element => element.textContent === 'Маршруты');
    expect(button).toBeTruthy();
    await act(async () => { button!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(app.textContent).toContain('Новый технологический маршрут');
  });

  it('never exposes order creation for a technologist server role', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith('/planning/workshops') ? { workshops: [] }
        : { routes: [] },
    }));
    vi.stubGlobal('fetch', fetchMock);
    setServerConnection({
      session: { serverUrl: 'https://mes.example.org', accessToken: 'technologist-token' },
      serverUrl: 'https://mes.example.org', organizationId: 'org',
      serverRole: 'technologist', serverActorId: 'technologist',
      selectedDeviceId: '', enrolledDeviceId: '', myDevices: [],
    });
    const app = await renderPlanning();
    expect(app.textContent).toContain('только начальнику производства');
    expect(app.textContent).not.toContain('Новый производственный заказ');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
