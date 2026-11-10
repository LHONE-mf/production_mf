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

  it('uses the server bearer token for send, receive and scoped handover inbox', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ handoffs: [] }) };
    }));
    await planningApi.handoffInbox(session);
    await planningApi.batchHandoffs(session, 'batch-1');
    await planningApi.sendHandoff(session, 'batch-1', {
      handoffId: 'handoff-1', fromStep: 1, toStep: 2,
      quantity: '12.500000', quantityUnit: 'kg', note: 'Coating handover',
    });
    await planningApi.receiveHandoff(session, 'handoff-1', 'Count checked');
    expect(calls.map(call => call.url)).toEqual([
      'https://mes.example.org/planning/handoffs/inbox',
      'https://mes.example.org/planning/batches/batch-1/handoffs',
      'https://mes.example.org/planning/batches/batch-1/handoffs',
      'https://mes.example.org/planning/handoffs/handoff-1/receive',
    ]);
    expect(calls.map(call => call.options.method)).toEqual(['GET','GET','POST','POST']);
    expect(calls.every(call => (call.options.headers as Record<string, string>).Authorization ===
      'Bearer server-session-only')).toBe(true);
    expect(calls.every(call => call.options.redirect === 'error')).toBe(true);
    expect(JSON.parse(String(calls[2].options.body))).toMatchObject({
      handoffId: 'handoff-1', fromStep: 1, toStep: 2, quantity: '12.500000',
    });
    expect(JSON.parse(String(calls[3].options.body))).toEqual({ note: 'Count checked' });
  });

  it('reads genealogy and records a source-to-target declaration with exact quantities', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ links: [] }) };
    }));
    expect((await planningApi.batchGenealogy(session, 'cell-batch')).links).toEqual([]);
    await planningApi.declareGenealogy(session, 'cell-batch', {
      sourceBatchId: 'cathode-batch', kind: 'assembly',
      sourceQuantity: '12.500000', sourceUnit: 'kg',
      targetQuantity: '100.000000', targetUnit: 'cells',
      note: 'Pilot genealogy',
    });
    expect(calls.map(call => call.url)).toEqual([
      'https://mes.example.org/planning/batches/cell-batch/links',
      'https://mes.example.org/planning/batches/cell-batch/links',
    ]);
    expect(calls.map(call => call.options.method)).toEqual(['GET', 'POST']);
    expect(calls.every(call => (call.options.headers as Record<string, string>).Authorization ===
      'Bearer server-session-only')).toBe(true);
    expect(calls.every(call => call.options.redirect === 'error')).toBe(true);
    expect(JSON.parse(String(calls[1].options.body))).toEqual({
      sourceBatchId: 'cathode-batch', kind: 'assembly',
      sourceQuantity: '12.500000', sourceUnit: 'kg',
      targetQuantity: '100.000000', targetUnit: 'cells',
      note: 'Pilot genealogy',
    });
  });

  it('keeps a caller-supplied genealogy UUID unchanged when retrying after a lost reply', async () => {
    const sent: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: RequestInit) => {
      sent.push(String(options.body));
      return { ok: true, json: async () => ({ id: 'operation-1' }) };
    }));
    const declaration = {
      declarationId: '0b152b11-2437-4c31-a005-42bc20f38676',
      sourceBatchId: 'cathode-1', kind: 'assembly' as const,
      sourceQuantity: '2.500000', sourceUnit: 'kg' as const,
      targetQuantity: '100', targetUnit: 'cells' as const,
    };
    await planningApi.declareGenealogy(session, 'cell-1', declaration);
    await planningApi.declareGenealogy(session, 'cell-1', declaration);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toBe(sent[1]);
    expect(JSON.parse(sent[0]).declarationId).toBe(declaration.declarationId);
  });

  it('transmits route-step evidence as exact authenticated and non-redirecting requests', async () => {
    const calls: Array<{ url: string; options: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
      calls.push({ url, options });
      return { ok: true, json: async () => ({ steps: [] }) };
    }));
    expect((await planningApi.stepEvidence(session, 'batch-1')).steps).toEqual([]);
    const evidence = {
      eventId: '80af22b0-5d66-40e1-8eea-2c5d9b62e2dd',
      kind: 'completed' as const, quantity: '48.500000',
      quantityUnit: 'kg' as const, equipmentCode: 'CUT-LINE',
      note: 'Operation recorded',
    };
    await planningApi.recordStepEvidence(session, 'batch-1', 2, evidence);
    await planningApi.recordStepEvidence(session, 'batch-1', 2, evidence);
    expect(calls.map(call => call.url)).toEqual([
      'https://mes.example.org/planning/batches/batch-1/steps',
      'https://mes.example.org/planning/batches/batch-1/steps/2/evidence',
      'https://mes.example.org/planning/batches/batch-1/steps/2/evidence',
    ]);
    expect(calls.map(call => call.options.method)).toEqual(['GET','POST','POST']);
    expect(calls.every(call => (call.options.headers as Record<string,string>).Authorization ===
      'Bearer server-session-only')).toBe(true);
    expect(calls.every(call => call.options.redirect === 'error')).toBe(true);
    expect(JSON.parse(String(calls[1].options.body))).toEqual(evidence);
    expect(calls[1].options.body).toBe(calls[2].options.body);
  });

  it('uses a read-only authenticated request for quantity reconciliation', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok:true,json:async () => ({batchId:'lot-1',steps:[]}),
    });
    vi.stubGlobal('fetch',fetchMock);
    expect((await planningApi.quantityFlow(session,'lot-1')).steps).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mes.example.org/planning/batches/lot-1/quantity-flow',
      expect.objectContaining({
        method:'GET',redirect:'error',credentials:'omit',
        headers:expect.objectContaining({Authorization:'Bearer server-session-only'}),
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
