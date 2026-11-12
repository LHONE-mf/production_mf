import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { db } from '../core/db';
import { setWorkshopKey, signPacket, verifyPacketSig } from '../core/security';
import { StageId, TaskPriority, TaskStatus, UserRole, type SyncPacket, type Task } from '../core/types';
import { applyPacket } from './apply';
import { currentSenderRole, decodePacket, decodePacketFromQr, encodePacket, toQrChunks } from './packet';
import { useAuthStore } from '../core/store/authStore';

const user = { id: 'existing', login: 'chief', password: 'original-hash', fullName: 'Local chief',
  role: UserRole.CHIEF, isActive: true, createdAt: new Date() };
const task: Task = { id: 'local-task', title: 'Recorded work', description: '', assignedTo: '', createdBy: 'existing',
  priority: TaskPriority.MEDIUM, status: TaskStatus.CREATED, comments: [], attachments: [],
  createdAt: new Date('2026-11-10T08:00:00Z'), updatedAt: new Date('2026-11-10T08:00:00Z') };
const packet = (type: SyncPacket['type'], payload: unknown): SyncPacket =>
  ({ v: 1, type, payload, from: 'existing', ts: Date.parse('2026-11-12T10:00:00Z'), role: UserRole.CHIEF });
async function signed(p: SyncPacket) { return { ...p, sig: await signPacket(p) }; }
const raw = (p: unknown) => 'LIP:' + btoa(unescape(encodeURIComponent(JSON.stringify(p))));

beforeEach(async () => { await db.open(); await db.users.put(user); await db.tasks.put(task); setWorkshopKey('TEST-shared-key'); });
afterEach(async () => { vi.restoreAllMocks(); useAuthStore.getState().logout(); db.close(); await db.delete(); localStorage.clear(); });

it('does not take sender authority from persisted authenticated flags or role claims', () => {
  localStorage.setItem('auth-storage', JSON.stringify({ state: { isAuthenticated: true, session: { role: UserRole.CHIEF } } }));
  expect(currentSenderRole()).toBeUndefined();
  useAuthStore.getState().login({ ...user, role: UserRole.WORKER });
  expect(currentSenderRole()).toBe(UserRole.WORKER);
});

it('never treats a valid shared HMAC and chief/master claim as account or forced-write authority', async () => {
  for (const role of [UserRole.MASTER, UserRole.CHIEF]) {
    for (const p of [packet('user', { ...user, password: 'attacker-hash' }),
      packet('forced-push', { ...task, title: 'Overwrite' }), { ...packet('task', { ...task, title: 'Overwrite' }), forced: true }]) {
      const incoming = await signed({ ...p, role });
      expect(await verifyPacketSig(incoming)).toBe(true);
      expect(decodePacket(raw(incoming))).toEqual(JSON.parse(JSON.stringify(incoming)));
      const result = await applyPacket(incoming);
      expect(result.ok).toBe(false);
      expect(result.message).toContain('Общий ключ');
      await expect(encodePacket({ ...p, role })).rejects.toThrow('Общий ключ');
    }
  }
  expect(await db.users.get(user.id)).toEqual(user);
  expect(await db.tasks.get(task.id)).toEqual(task);
});

it('keeps signed nonforced local data usable without granting permissions', async () => {
  const journal = { id: 'TEST-note', stage: StageId.COATING, workerId: 'existing', createdAt: new Date(), note: 'Observed only' };
  const incoming = decodePacket(await encodePacket(packet('journal', journal)))!;
  expect((await applyPacket(incoming)).ok).toBe(true);
  expect(await db.journal.get(journal.id)).toEqual(JSON.parse(JSON.stringify(journal)));
  expect(await db.users.get(user.id)).toEqual(user);
});

it('rejects role-controlled catalogs and remote calender settings without changing local records', async () => {
  const recipe = { id: 'local-recipe', name: 'Original', lines: [], mode: [], dryMassKg: 1, updatedBy: 'existing', updatedAt: 1 };
  await db.mixRecipes.put(recipe);
  for (const p of [packet('mix-recipe', { ...recipe, name: 'Spoofed' }), packet('mix-component', { id: 'component' }),
    packet('sort-spec', { id: 'spec' }), packet('roll-spec', { roll: { id: 'roll', segLengthsM: [1] }, calenderParams: { targetThicknessUm: 99 } })]) {
    expect((await applyPacket(await signed(p))).ok).toBe(false);
  }
  expect(await db.mixRecipes.get(recipe.id)).toEqual(recipe);
  expect(await db.calenderRuns.count()).toBe(0);
  expect(await db.rollSpecs.count()).toBe(0);
  const roll = { id: 'roll', mixName: 'Declared roll', segLengthsM: [1], createdAt: 1 };
  expect((await applyPacket(await signed(packet('roll-spec', { roll })))).ok).toBe(true);
  expect((await applyPacket(await signed(packet('roll-spec', { roll: { ...roll, segLengthsM: [999] } })))).ok).toBe(false);
  expect(await db.rollSpecs.get(roll.id)).toEqual(roll);
});

it('rejects malformed tasks/results and envelopes before any write, accepting normal serialized dates', async () => {
  for (const payload of [{ ...task, status: 'approved' }, { ...task, id: ' ' }, { ...task, title: '' },
    { ...task, updatedAt: 'nonsense' }, { ...task, createdAt: null }, { ...task, createdBy: 42 },
    { ...task, updatedAt: new Date('2020-01-01') }, { ...task, comments: {} }, { ...task, priority: 'urgent' }]) {
    expect((await applyPacket(await signed(packet('task', payload)))).ok).toBe(false);
  }
  for (const p of [packet('result', { taskId: task.id, status: 'approved' }), packet('result', { taskId: ' ', status: TaskStatus.CHECKED }),
    { ...packet('result', { taskId: task.id, status: TaskStatus.CHECKED }), ts: NaN }]) {
    expect((await applyPacket(await signed(p))).ok).toBe(false);
  }
  expect(await db.tasks.get(task.id)).toEqual(task);
  const received = decodePacket(await encodePacket(packet('task', { ...task, updatedAt: new Date('2026-11-11'), title: 'Valid edit' })))!;
  expect((await applyPacket(received)).ok).toBe(true);
  expect((await db.tasks.get(task.id))?.updatedAt).toEqual(new Date('2026-11-11'));
});

it('bounds input sizes and rejects malformed envelopes and frame metadata', () => {
  for (const p of [{}, { ...packet('task', task), type: 'unknown' }, { ...packet('task', task), from: '' },
    { ...packet('task', task), ts: '2026' }, { ...packet('task', task), payload: null }]) expect(decodePacket(raw(p))).toBeNull();
  expect(decodePacket('LIP:' + 'A'.repeat(1_500_001))).toBeNull();
  for (const frame of ['LIPM:bad:-1/2:AAAA', 'LIPM:bad:0.5/2:AAAA', 'LIPM:bad:0/2x:AAAA',
    'LIPM:bad:0/999999:AAAA', 'LIPM:bad:0/2:' + 'A'.repeat(2049)]) expect(decodePacketFromQr(frame)).toBeNull();
  expect(() => toQrChunks('LIP:AAAA', 0)).toThrow();
  expect(() => toQrChunks('LIP:AAAA', 1.5)).toThrow();
});

it('roundtrips Unicode out of order while rejecting conflicting totals and duplicate content', async () => {
  const encoded = await encodePacket(packet('journal', { id: 'unicode', note: 'Привет '.repeat(50) }));
  const frames = toQrChunks(encoded, 500);
  expect(frames.length).toBeGreaterThan(1);
  for (const frame of frames.slice(1).reverse()) expect(decodePacketFromQr(frame)).toBeNull();
  expect(decodePacketFromQr(frames[0])?.payload).toEqual({ id: 'unicode', note: 'Привет '.repeat(50) });
  expect(decodePacketFromQr(frames[0])).toBeNull();
  expect(decodePacketFromQr(frames[0].replace(/0\/\d+:/, '0/100:'))).toBeNull();
  for (const frame of frames.slice(1)) expect(decodePacketFromQr(frame)).toBeNull();
  expect(decodePacketFromQr(frames[0])?.type).toBe('journal');
  // Discard the assembly after a conflicting duplicate rather than combining frames.
  expect(decodePacketFromQr(frames[0])).toBeNull();
  expect(decodePacketFromQr(frames[0].slice(0, -1) + (frames[0].endsWith('A') ? 'B' : 'A'))).toBeNull();
  for (const frame of frames.slice(1)) expect(decodePacketFromQr(frame)).toBeNull();
});

it('expires an existing assembly on every frame and evicts old entries when flooded', () => {
  const body = raw(packet('journal', { id: 'bounded', note: 'TEST '.repeat(20) })).slice(4);
  const half = Math.ceil(body.length / 2);
  let now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  expect(decodePacketFromQr(`LIPM:expiry:0/2:${body.slice(0, half)}`)).toBeNull();
  now += 5 * 60 * 1000;
  expect(decodePacketFromQr(`LIPM:expiry:1/2:${body.slice(half)}`)).toBeNull();
  expect(decodePacketFromQr(`LIPM:flood:0/2:${body.slice(0, half)}`)).toBeNull();
  for (let i = 0; i < 16; i++) expect(decodePacketFromQr(`LIPM:entry${i}:0/2:AAAA`)).toBeNull();
  expect(decodePacketFromQr(`LIPM:flood:1/2:${body.slice(half)}`)).toBeNull();
});

it('bounds decoded bytes, frame counts and memory across concurrent large assemblies', async () => {
  const oversized = packet('journal', { id: 'large', note: 'A'.repeat(1_048_576) });
  expect(decodePacket(raw(oversized))).toBeNull();
  await expect(encodePacket(oversized)).rejects.toThrow('слишком большой');
  expect(() => toQrChunks('LIP:' + 'A'.repeat(1201), 1)).toThrow();
  const bodies = [0, 1, 2].map(i => raw(packet('journal', { id: `large${i}`, note: 'A'.repeat(850_000) })));
  const frames = bodies.map((body, i) => toQrChunks(body, 2048).map(frame => frame.replace(/^LIPM:[^:]+:/, `LIPM:large${i}:`)));
  for (const assembly of frames.slice(0, 2)) for (const frame of assembly.slice(0, -1)) expect(decodePacketFromQr(frame)).toBeNull();
  // The third assembly crosses the shared memory cap and loses its partial data.
  for (const frame of frames[2]) expect(decodePacketFromQr(frame)).toBeNull();
  expect(decodePacketFromQr(frames[0][frames[0].length - 1])?.payload).toEqual({ id: 'large0', note: 'A'.repeat(850_000) });
  expect(decodePacketFromQr(frames[1][frames[1].length - 1])?.payload).toEqual({ id: 'large1', note: 'A'.repeat(850_000) });
});
