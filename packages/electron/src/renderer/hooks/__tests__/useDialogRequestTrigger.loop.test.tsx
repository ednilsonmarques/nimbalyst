// @vitest-environment jsdom
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useDialogRequestTrigger } from '../useDialogRequestTrigger';

/**
 * The shape of the confirm-close bug (React #185): the owner passes a callback that closes over a
 * fresh object on every render (like useConfirmDialog()), and handling the request sets state, which
 * re-renders. The trigger must fire once per version, not once per render.
 */
describe('confirm-close request trigger (NIB.97)', () => {
  it('fires once per version even though its callback and its state change on every render', () => {
    const handled = vi.fn();
    const { result, rerender } = renderHook(({ version }) => {
      const [, setOpen] = useState(0);
      const dialog = { open: () => setOpen((n) => n + 1) }; // new object each render
      useDialogRequestTrigger(version, true, () => {
        handled();
        dialog.open();
      });
      return null;
    }, { initialProps: { version: 0 } });

    expect(handled).not.toHaveBeenCalled();
    act(() => rerender({ version: 1 }));
    expect(handled).toHaveBeenCalledTimes(1);
    act(() => rerender({ version: 1 }));
    act(() => rerender({ version: 1 }));
    expect(handled).toHaveBeenCalledTimes(1);
    act(() => rerender({ version: 2 }));
    expect(handled).toHaveBeenCalledTimes(2);
    expect(result.current).toBeNull();
  });
});
