import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setServerConnection, clearServerConnection, type ServerConnection } from '../../core/sync/serverConnection';
import type { BatchGenealogyLink } from '../../core/planning/planningClient';
import { BatchGenealogyPanel } from './BatchGenealogyPanel';

const connection: ServerConnection = {
  session:{serverUrl:'https://mes.example.org',accessToken:'memory-only-chief'},
  serverUrl:'https://mes.example.org',organizationId:'org',serverRole:'chief',
  serverActorId:'chief',selectedDeviceId:'',enrolledDeviceId:'',myDevices:[],
};
const link = (source: string, target: string, id = source+'-'+target): BatchGenealogyLink => ({
  id,sourceBatchId:source,targetBatchId:target,sourceCode:source.toUpperCase(),
  targetCode:target.toUpperCase(),kind:'consumption',sourceQuantity:'12.500001',
  sourceUnit:'kg',targetQuantity:'100.000000',targetUnit:'cells',actorId:'chief',
  note:'Provenance note',occurredAt:'2026-11-10T10:00:00Z',
});
const response = (batchId: string, links: BatchGenealogyLink[], nextAfter: string | null = null) =>
  ({ok:true,json:async () => ({batchId,links,hasMore:nextAfter !== null,nextAfter})});
let root: Root | undefined;
let container: HTMLDivElement;
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
  setServerConnection(connection);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<BatchGenealogyPanel connection={connection} batch={{id:'cell',batchCode:'CELL'}} />);
  });
  return container;
}
async function click(text: string) {
  const button = [...container.querySelectorAll('button')].find(b => b.textContent === text);
  expect(button, text).toBeTruthy();
  await act(async () => { button!.click(); });
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  container?.remove();
  clearServerConnection();
  vi.unstubAllGlobals();
});

describe('M2 multi-level batch genealogy browser', () => {
  it('follows ancestors and descendants outside the loaded batch list and returns along the path', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/cell/links')) return response('cell',[link('cathode','cell'),link('cell','finished')]);
      if (url.endsWith('/cathode/links')) return response('cathode',[link('slurry','cathode'),link('cathode','cell')]);
      if (url.endsWith('/slurry/links')) return response('slurry',[link('slurry','cathode')]);
      return response('finished',[link('cell','finished')]);
    });
    vi.stubGlobal('fetch',fetchMock);
    const screen = await mount();
    expect(screen.textContent).toContain('12.500001 kg');
    expect(screen.textContent).toContain('не подтверждают физический расход');
    await click('CATHODE');
    expect(screen.textContent).toContain('Просматривается: CATHODE');
    await click('SLURRY');
    expect(screen.textContent).toContain('Просматривается: SLURRY');
    const path = screen.querySelector('nav[aria-label="Путь просмотра происхождения"]');
    expect(path?.textContent).toContain('CELL');
    expect(path?.textContent).toContain('CATHODE');
    await click('Назад по связям');
    expect(screen.textContent).toContain('Просматривается: CATHODE');
    await click('К исходной партии');
    expect(screen.textContent).toContain('Просматривается: CELL');
    await click('FINISHED');
    expect(screen.textContent).toContain('Просматривается: FINISHED');
    expect(fetchMock).toHaveBeenCalledWith('https://mes.example.org/planning/batches/slurry/links',
      expect.objectContaining({method:'GET',redirect:'error',credentials:'omit',
        headers:expect.objectContaining({Authorization:'Bearer memory-only-chief'})}));
  });

  it('keeps loaded declarations when a later page fails and retries the same cursor', async () => {
    const a = link('cathode','cell'), b = link('anode','cell');
    let attempts = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('?after=')) {
        if (++attempts === 1) throw new Error('Network unavailable');
        return response('cell',[b]);
      }
      return response('cell',[a],a.id);
    });
    vi.stubGlobal('fetch',fetchMock);
    const screen = await mount();
    expect(screen.textContent).toContain('Есть ещё связи');
    await click('Загрузить ещё связи');
    expect(screen.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable');
    expect(screen.textContent).toContain('CATHODE → CELL');
    await click('Повторить загрузку');
    expect(screen.textContent).toContain('ANODE → CELL');
    expect(screen.textContent).toContain('CATHODE → CELL');
    expect(screen.textContent).not.toContain('Есть ещё связи');
    expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[2][0]);
  });

  it('ignores an obsolete request when navigation changes before it resolves', async () => {
    let resolveLate: (value: ReturnType<typeof response>) => void = () => {};
    let cathodeRequests = 0;
    vi.stubGlobal('fetch',vi.fn(async (url: string) => {
      if (url.endsWith('/cell/links')) return response('cell',[link('cathode','cell')]);
      if (++cathodeRequests === 1)
        return new Promise<ReturnType<typeof response>>(resolve => { resolveLate = resolve; });
      return response('cathode',[]);
    }));
    const screen = await mount();
    await click('CATHODE');
    await click('К исходной партии');
    await act(async () => { resolveLate(response('cathode',[link('stale','cathode')])); });
    expect(screen.textContent).toContain('Просматривается: CELL');
    expect(screen.textContent).not.toContain('STALE');
  });

  it('shows a failed read instead of claiming that the batch has no links, and clears expired login', async () => {
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:false,status:401,
      json:async () => ({error:'unauthorized'})}));
    const screen = await mount();
    expect(screen.querySelector('[role="alert"]')?.textContent).toContain('HTTP 401');
    expect(screen.textContent).not.toContain('Связей с другими партиями пока нет');
    const {getServerConnection} = await import('../../core/sync/serverConnection');
    expect(getServerConnection()).toBeNull();
  });
});
