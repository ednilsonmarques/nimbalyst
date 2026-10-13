import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AISessionsRepository } from '../../../../storage/repositories/AISessionsRepository';
import { BaseAgentProvider } from '../BaseAgentProvider';

// getToolScope and getToolPolicyRole only touch the provider's own frozen
// policy map (through getToolPolicy on the prototype), so a prototype-backed
// receiver carrying that map is enough.
type Receiver = { frozenToolPolicies: Map<string, Promise<{ scope: string; role: string | null }>> };

const getToolScope = (BaseAgentProvider.prototype as any).getToolScope as (this: Receiver, sessionId?: string) => Promise<string>;
const getToolPolicyRole = (BaseAgentProvider.prototype as any).getToolPolicyRole as (this: Receiver, sessionId?: string) => Promise<string | null>;

function receiver(): Receiver {
  const self = Object.create(BaseAgentProvider.prototype) as Receiver;
  self.frozenToolPolicies = new Map();
  return self;
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
    expect(self.frozenToolPolicies.has('child-3')).toBe(false);

    get.mockResolvedValue({ metadata: { toolScope: 'read' } });
    expect(await getToolScope.call(self, 'child-3')).toBe('read');
  });
});

describe('BaseAgentProvider.getToolPolicyRole (Phase 1A: the team role rides the same frozen read)', () => {
  beforeEach(() => {
    get.mockReset();
    AISessionsRepository.setStore({ get } as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    AISessionsRepository.clearStore();
    vi.restoreAllMocks();
  });

  it('reads the scope and the team role from one row and freezes both', async () => {
    get.mockResolvedValue({ agentRole: 'standard', metadata: { toolScope: 'read', teamChild: { role: 'architect', rootSessionId: 'r', depth: 1 } } });
    const self = receiver();
    expect(await getToolScope.call(self, 'arch')).toBe('read');
    expect(await getToolPolicyRole.call(self, 'arch')).toBe('architect');
    get.mockResolvedValue({ agentRole: 'standard', metadata: { toolScope: 'full', teamChild: { role: 'explorer', rootSessionId: 'r', depth: 1 } } });
    expect(await getToolPolicyRole.call(self, 'arch')).toBe('architect');
    expect(await getToolScope.call(self, 'arch')).toBe('read');
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('is null for a normal session, a team root, a malformed teamChild and a meta-agent', async () => {
    get.mockResolvedValue({ agentRole: 'standard', metadata: {} });
    expect(await getToolPolicyRole.call(receiver(), 'plain')).toBeNull();
    get.mockResolvedValue({ agentRole: 'standard', metadata: { teamMode: true } });
    expect(await getToolPolicyRole.call(receiver(), 'root')).toBeNull();
    get.mockResolvedValue({ agentRole: 'standard', metadata: { teamChild: { role: 'boss', rootSessionId: 'r', depth: 1 } } });
    expect(await getToolPolicyRole.call(receiver(), 'junk')).toBeNull();
    get.mockResolvedValue({ agentRole: 'meta-agent', metadata: { teamChild: { role: 'architect', rootSessionId: 'r', depth: 1 } } });
    expect(await getToolPolicyRole.call(receiver(), 'meta')).toBeNull();
    expect(await getToolPolicyRole.call(receiver(), undefined)).toBeNull();
  });

  it('is null without a session store, as the scope is full', async () => {
    AISessionsRepository.clearStore();
    expect(await getToolPolicyRole.call(receiver(), 'headless')).toBeNull();
  });

  it('fails closed with the scope: a store that cannot be read rejects the turn and freezes nothing', async () => {
    const self = receiver();
    get.mockRejectedValue(new Error('db down'));
    await expect(getToolPolicyRole.call(self, 'child-4')).rejects.toThrow(/turn was not run/);
    expect(self.frozenToolPolicies.has('child-4')).toBe(false);
    get.mockResolvedValue({ agentRole: 'standard', metadata: { toolScope: 'read', teamChild: { role: 'architect', rootSessionId: 'r', depth: 1 } } });
    expect(await getToolPolicyRole.call(self, 'child-4')).toBe('architect');
  });
});
