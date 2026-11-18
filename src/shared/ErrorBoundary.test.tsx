import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

it('offers recovery without exposing raw error details or asserting that data is intact', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const reset = vi.fn();
  let fail = true;
  function Screen() {
    if (fail) throw Error('internal-debug-only');
    return <p>Recovered</p>;
  }
  try {
    await act(async () => root.render(<ErrorBoundary onReset={reset}><Screen /></ErrorBoundary>));
    expect(node.querySelector('[role="alert"]')?.textContent).toContain('проверьте сохранённые данные');
    expect(node.textContent).not.toContain('internal-debug-only');
    expect(node.textContent).not.toContain('Данные остались целы');
    fail = false;
    await act(async () => node.querySelector('button')!.click());
    expect(reset).toHaveBeenCalledOnce();
    expect(node.textContent).toContain('Recovered');
  } finally {
    await act(async () => root.unmount());
    node.remove();
    log.mockRestore();
    vi.unstubAllGlobals();
  }
});
