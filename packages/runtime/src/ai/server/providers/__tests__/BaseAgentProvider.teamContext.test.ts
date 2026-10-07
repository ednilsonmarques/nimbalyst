import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AISessionsRepository } from '../../../../storage/repositories/AISessionsRepository';
import { BaseAgentProvider } from '../BaseAgentProvider';
import { NO_TEAM } from '../teamContext';

// getTeamContext only touches its own frozen map, so a bare receiver is enough.
const getTeamContext = (BaseAgentProvider.prototype as any).getTeamContext as (
  this: { frozenTeamContexts: Map<string, Promise<unknown>> },
  sessionId?: string,
) => Promise<unknown>;

function receiver() {
  return { frozenTeamContexts: new Map<string, Promise<unknown>>() };
}

const get = vi.fn();

describe('BaseAgentProvider.getTeamContext', () => {
  beforeEach(() => {
    get.mockReset();
    AISessionsRepository.setStore({ get } as never);
  });
  afterEach(() => {
    AISessionsRepository.clearStore();
  });

  it('reads a root once and freezes it, even if the row changes later', async () => {
    get.mockResolvedValue({ agentRole: 'standard', metadata: { teamMode: true } });
    const self = receiver();
    expect(await getTeamContext.call(self, 'root')).toEqual({ teamMode: true, teamChild: null });
    get.mockResolvedValue({ agentRole: 'standard', metadata: {} });
    expect(await getTeamContext.call(self, 'root')).toEqual({ teamMode: true, teamChild: null });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('reads a member', async () => {
    const teamChild = { role: 'implementer', rootSessionId: 'root', depth: 1 };
    get.mockResolvedValue({ agentRole: 'standard', metadata: { teamChild } });
    expect(await getTeamContext.call(receiver(), 'child')).toEqual({ teamMode: false, teamChild });
  });

  it('is no team for normal sessions, meta-agents, and runtimes without a store', async () => {
    get.mockResolvedValue({ agentRole: 'standard', metadata: { phase: 'planning' } });
    expect(await getTeamContext.call(receiver(), 'plain')).toBe(NO_TEAM);
    get.mockResolvedValue({ agentRole: 'meta-agent', metadata: { teamMode: true } });
    expect(await getTeamContext.call(receiver(), 'meta')).toBe(NO_TEAM);
    AISessionsRepository.clearStore();
    expect(await getTeamContext.call(receiver(), 'headless')).toBe(NO_TEAM);
  });

  it('does not freeze a failed read', async () => {
    const self = receiver();
    get.mockRejectedValueOnce(new Error('db busy'));
    expect(await getTeamContext.call(self, 'root')).toBe(NO_TEAM);
    get.mockResolvedValue({ agentRole: 'standard', metadata: { teamMode: true } });
    expect(await getTeamContext.call(self, 'root')).toEqual({ teamMode: true, teamChild: null });
  });
});
