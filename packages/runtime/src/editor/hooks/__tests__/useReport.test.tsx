// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import useReport from '../useReport';

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('useReport (HTML audit, item 5a)', () => {
  it('renders the message as text: markup in it creates no element and runs no handler', () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const payload = '<img src=x onerror="window.__pwned = true"><b>bold</b>';
    const { result } = renderHook(() => useReport());
    act(() => { result.current(payload); });
    const container = document.getElementById('report-container')!;
    expect(container.textContent).toBe(payload);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.children.length).toBe(0);
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it('still shows plain text and removes the container after its timeout', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { result } = renderHook(() => useReport());
    act(() => { result.current('Saved'); });
    expect(document.getElementById('report-container')?.textContent).toBe('Saved');
    act(() => { vi.advanceTimersByTime(1100); });
    expect(document.getElementById('report-container')).toBeNull();
  });
});
