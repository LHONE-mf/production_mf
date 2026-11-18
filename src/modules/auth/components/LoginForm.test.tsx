import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoginForm } from './LoginForm';

const mocks = vi.hoisted(() => ({ login: vi.fn(), authLogin: vi.fn() }));
vi.mock('../services/AuthService', () => ({ AuthService: { login: mocks.login } }));
vi.mock('../../../core/store/authStore', () => ({
  useAuthStore: () => ({ login: mocks.authLogin }),
}));
vi.mock('../../../core/db', () => ({ clearLocalDatabase: vi.fn() }));
vi.mock('../../../core/sync/serverConnection', () => ({ clearServerConnection: vi.fn() }));

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocks.login.mockReset();
  mocks.authLogin.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it('associates sign-in labels with inputs and declares appropriate autocomplete purposes', async () => {
  await act(async () => root.render(<LoginForm />));
  const username = host.querySelector<HTMLInputElement>('input[autocomplete="username"]')!;
  const password = host.querySelector<HTMLInputElement>('input[autocomplete="current-password"]')!;
  expect(username).not.toBeNull();
  expect(password).not.toBeNull();
  const labels = Array.from(host.querySelectorAll('label'));
  expect(labels.find(label => label.htmlFor === username.id)?.textContent?.trim()).toBe('Логин');
  expect(labels.find(label => label.htmlFor === password.id)?.textContent?.trim()).toBe('Пароль');
});

it('keeps sign-in progress readable and announces an unsuccessful sign-in', async () => {
  let resolveLogin!: (value: null) => void;
  mocks.login.mockImplementationOnce(() => new Promise(resolve => { resolveLogin = resolve; }));
  await act(async () => root.render(<LoginForm />));
  const form = host.querySelector('form')!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(form.getAttribute('aria-busy')).toBe('true');
  expect(submit.disabled).toBe(true);
  expect(submit.textContent).toContain('Проверяем');
  await act(async () => resolveLogin(null));
  expect(form.getAttribute('aria-busy')).toBe('false');
  expect(submit.disabled).toBe(false);
  expect(host.querySelector('[role="alert"]')?.textContent).toContain('Неверный логин или пароль');
  expect(mocks.authLogin).not.toHaveBeenCalled();
});
