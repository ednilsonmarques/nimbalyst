import { describe, it, expect } from 'vitest';
import { shouldEnableRemoteDebugging } from '../remoteDebugging';

describe('shouldEnableRemoteDebugging', () => {
  it('is off in a packaged build when NODE_ENV is absent', () => {
    expect(shouldEnableRemoteDebugging({ isPackaged: true, env: {} })).toBe(false);
  });

  it('stays off in a packaged build even if NIMBALYST_CDP_PORT is set', () => {
    expect(
      shouldEnableRemoteDebugging({ isPackaged: true, env: { NIMBALYST_CDP_PORT: '9480' } })
    ).toBe(false);
  });

  it('is on when not packaged and NODE_ENV is absent', () => {
    expect(shouldEnableRemoteDebugging({ isPackaged: false, env: {} })).toBe(true);
  });

  it('is on when not packaged with a custom port', () => {
    expect(
      shouldEnableRemoteDebugging({ isPackaged: false, env: { NIMBALYST_CDP_PORT: '9480' } })
    ).toBe(true);
  });

  it('is on when not packaged and NODE_ENV is development', () => {
    expect(shouldEnableRemoteDebugging({ isPackaged: false, env: { NODE_ENV: 'development' } })).toBe(true);
  });

  it('is off when NODE_ENV is production even if not packaged', () => {
    expect(shouldEnableRemoteDebugging({ isPackaged: false, env: { NODE_ENV: 'production' } })).toBe(false);
  });

  it('is off when packaged and NODE_ENV is production', () => {
    expect(shouldEnableRemoteDebugging({ isPackaged: true, env: { NODE_ENV: 'production' } })).toBe(false);
  });
});
