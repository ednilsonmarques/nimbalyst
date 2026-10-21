import { describe, expect, it } from 'vitest';
import { isSessionNameLocked } from '../sessionNameLock';

const teamChild = { role: 'implementer', rootSessionId: 'root', depth: 1 };

describe('isSessionNameLocked (NIB.102)', () => {
  it('locks a named team member', () => {
    expect(isSessionNameLocked({ hasBeenNamed: true, metadata: { teamChild } })).toBe(true);
  });

  it('does not lock a named session outside a team', () => {
    expect(isSessionNameLocked({ hasBeenNamed: true, metadata: {} })).toBe(false);
    expect(isSessionNameLocked({ hasBeenNamed: true })).toBe(false);
  });

  it('does not lock an unnamed team member: it names itself once', () => {
    expect(isSessionNameLocked({ hasBeenNamed: false, metadata: { teamChild } })).toBe(false);
  });

  it('does not lock a missing session', () => {
    expect(isSessionNameLocked(null)).toBe(false);
    expect(isSessionNameLocked(undefined)).toBe(false);
  });
});
