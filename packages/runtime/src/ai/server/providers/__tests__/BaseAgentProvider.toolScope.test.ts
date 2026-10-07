import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AISessionsRepository } from '../../../../storage/repositories/AISessionsRepository';
import { BaseAgentProvider } from '../BaseAgentProvider';

// getToolScope only touches its own frozen map, so a bare receiver is enough.
const getToolScope = (BaseAgentProvider.prototype as any).getToolScope as (
  this: { frozenToolScopes: Map<string, Promise<string>> },
  sessionId?: string,
) => Promise<string>;

function receiver() {
  return { frozenToolScopes: new Map<string, Promise<string>>() };
}

const get = vi.fn();

describe('BaseAgentProvider.getToolScope', () => {
  beforeEach(() => {
    get.mockReset();
    AISessionsRepository.setStore({ get } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    AISessionsRepository.clearStore();
    vi.restoreAllMocks();
  });

  it('reads metadata.toolScope once and freezes it', async () => {
    get.mockResolvedValue({ metadata: { toolScope: 'read' } });
    const self = receiver();
    expect(await getToolScope.call(self, 'child-1')).toBe('read');
    get.mockResolvedValue({ metadata: { toolScope: 'full' } });
    expect(await getToolScope.call(self, 'child-1')).toBe('read');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps a normal session without a scope at full', async () => {
    get.mockResolvedValue({ metadata: {} });
    expect(await getToolScope.call(receiver(), 'plain')).toBe('full');
    expect(await getToolScope.call(receiver(), undefined)).toBe('full');
  });

  it('is full when the runtime has no session store at all (nothing could have been persisted)', async () => {
    AISessionsRepository.clearStore();
    expect(await getToolScope.call(receiver(), 'headless')).toBe('full');
  });

  it('treats an unrecognized stored scope as read', async () => {
    get.mockResolvedValue({ metadata: { toolScope: 'read-only' } });
    expect(await getToolScope.call(receiver(), 'odd')).toBe('read');
  });

  it('retries a transient read failure once', async () => {
    get.mockRejectedValueOnce(new Error('db busy')).mockResolvedValueOnce({ metadata: { toolScope: 'write' } });
    expect(await getToolScope.call(receiver(), 'child-2')).toBe('write');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('fails closed: refuses the turn when the store cannot be read, and never freezes that', async () => {
    const self = receiver();
    get.mockRejectedValue(new Error('db down'));
    await expect(getToolScope.call(self, 'child-3')).rejects.toThrow(/turn was not run/);
    expect(self.frozenToolScopes.has('child-3')).toBe(false);

    get.mockResolvedValue({ metadata: { toolScope: 'read' } });
    expect(await getToolScope.call(self, 'child-3')).toBe('read');
  });
});
