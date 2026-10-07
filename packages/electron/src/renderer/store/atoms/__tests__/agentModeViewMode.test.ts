// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mergeWithDefaults } from '../agentMode';

// mergeWithDefaults is the single load path for the persisted Agent mode layout.
// 'team' must survive a restart; anything unknown falls back to 'list'.
describe('mergeWithDefaults - sessionHistoryLayout.viewMode', () => {
  it.each(['list', 'kanban', 'team'] as const)('preserves a persisted "%s" view mode', (viewMode) => {
    const merged = mergeWithDefaults({ sessionHistoryLayout: { viewMode } as never });
    expect(merged.sessionHistoryLayout.viewMode).toBe(viewMode);
  });

  it('coerces the retired "card" view mode to "list"', () => {
    const merged = mergeWithDefaults({ sessionHistoryLayout: { viewMode: 'card' } as never });
    expect(merged.sessionHistoryLayout.viewMode).toBe('list');
  });

  it('coerces garbage to "list"', () => {
    const merged = mergeWithDefaults({ sessionHistoryLayout: { viewMode: 42 } as never });
    expect(merged.sessionHistoryLayout.viewMode).toBe('list');
  });

  it('defaults to "list" when nothing is persisted', () => {
    expect(mergeWithDefaults(undefined).sessionHistoryLayout.viewMode).toBe('list');
  });
});
