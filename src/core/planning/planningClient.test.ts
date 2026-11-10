import { afterEach, describe, expect, it, vi } from 'vitest';
import { planningApi, planningRequest, type PlanningSession } from './planningClient';

const session: PlanningSession = {
  session: { serverUrl: 'https://mes.example.org', accessToken: 'server-session-only' },
};
afterEach(() => vi.unstubAllGlobals());

describe('authenticated M2 planning client', () => {
  it('reads workshop and route data using the verified memory-only server token', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ workshops: [{ id: 'coating', name: 'Coating' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    expect((await planningApi.workshops(session)).workshops[0].id).toBe('coating');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/workshops',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer server-session-only' }),
        cache: 'no-store',
        redirect: 'error',
        credentials: 'omit',
      }),
    );
  });

  it('refuses insecure, embedded-path and credential-bearing origins before exposing bearer credentials', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const serverUrl of [
      'http://mes.example.org', 'https://mes.example.org/api',
      'https://admin:secret@mes.example.org', 'https://mes.example.org/?next=elsewhere',
      'https://mes.example.org/#fragment',
    ]) {
      await expect(planningApi.orders({ session: { ...session.session, serverUrl } }))
        .rejects.toThrow();
    }
    await expect(planningRequest(session, '//evil.example.org/steal')).rejects.toThrow();
    await expect(planningRequest(session, '/auth/me')).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves server rejection details without treating rejected writes as successful', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false, status: 409,
      json: async () => ({ error: 'batch_status_changed' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(planningApi.changeBatchStatus(session, 'abc', {
      expectedStatus: 'created', status: 'in_progress',
    })).rejects.toThrow('HTTP 409: batch_status_changed');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/batches/abc/status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ expectedStatus: 'created', status: 'in_progress' }),
      }),
    );
  });

  it('uses exact typed JSON for order creation, batch creation and hold reasons', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, body: String(options.body) });
      return { ok: true, json: async () => ({ id: 'created' }) };
    }));
    await planningApi.createOrder(session, {
      orderCode: 'PO-2026-1', productCode: '18650-NMC', routeId: 'route-id',
      routeVersion: 2, plannedQuantity: '12.500000', quantityUnit: 'cells',
    });
    await planningApi.createBatch(session, 'order-id', {
      batchCode: 'A-001', materialLine: 'anode',
      plannedQuantity: '8.200000', quantityUnit: 'kg',
    });
    await planningApi.changeBatchStatus(session, 'batch-id', {
      expectedStatus: 'in_progress', status: 'hold', reason: 'Measured deviation',
    });
    expect(calls.map(call => call.url)).toEqual([
      'https://mes.example.org/planning/orders',
      'https://mes.example.org/planning/orders/order-id/batches',
      'https://mes.example.org/planning/batches/batch-id/status',
    ]);
    expect(JSON.parse(calls[0].body)).toMatchObject({ plannedQuantity: '12.500000', routeVersion: 2 });
    expect(JSON.parse(calls[1].body)).toMatchObject({ plannedQuantity: '8.200000', materialLine: 'anode' });
    expect(JSON.parse(calls[2].body)).toMatchObject({ reason: 'Measured deviation' });
  });
});
