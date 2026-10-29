// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: {} }));
vi.mock('../../ecc/eccCatalogService', () => ({ eccCatalogLookupTool: vi.fn() }));

import { META_AGENT_TOOL_DEFS, dispatchMetaAgentTool, setMetaAgentToolFns } from '../../../mcp/metaAgentServer';
import { TeamFrontProposalError, TeamFrontProposalRegistry, type TeamFrontProposalPorts } from '../teamFrontProposals';
import { postTeamFrontProposalCard, teamFrontProposalCardId, type TeamFrontProposalCardDeps } from '../teamFrontProposalCard';
import { proposeTeamFronts, TEAM_FRONT_PROPOSE_ROOT_ONLY, type TeamFrontProposeDeps, type TeamFrontProposeSessionRow } from '../teamFrontProposeTool';

const WS = '/ws';
const ROOT: TeamFrontProposeSessionRow = { metadata: { teamMode: true }, agentRole: 'standard', workspacePath: WS, isArchived: false };
const member = (role: string): TeamFrontProposeSessionRow => ({
  metadata: { teamChild: { rootSessionId: 'root', depth: 1, role } },
  agentRole: 'standard',
  workspacePath: WS,
  isArchived: false,
});
const ARGS = { items: [{ action: 'create', title: 'Portal', description: 'Goal and state.' }] };

function harness(session: TeamFrontProposeSessionRow | null | Error, options: { fronts?: Array<{ id: string; title: string; status: string }>; postFails?: boolean } = {}) {
  const writes: string[] = [];
  const posted: unknown[] = [];
  const fronts = options.fronts ?? [];
  const ports: TeamFrontProposalPorts = {
    listFronts: async () => fronts.map((f) => ({ ...f, archived: false })),
    getFront: async (id) => {
      const f = fronts.find((x) => x.id === id);
      return f ? { ...f, type: 'team-front', archived: false, description: null } : null;
    },
    findActiveMissionRoot: async () => null,
  };
  const registry = new TeamFrontProposalRegistry();
  const deps: TeamFrontProposeDeps = {
    readSession: async () => {
      if (session instanceof Error) throw session;
      return session;
    },
    ports,
    registry,
    postCard: async (proposal) => {
      if (options.postFails) throw new Error('db down');
      posted.push(proposal);
    },
  };
  return { deps, registry, posted, writes };
}

async function refusedWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await expect(promise).rejects.toThrow(pattern);
}

describe('team_front_propose: the host refuses the caller (AC-1)', () => {
  it('refuses a member of every role, and posts nothing', async () => {
    for (const role of ['explorer', 'implementer', 'reviewer', 'architect', 'advisor', 'other']) {
      const h = harness(member(role));
      await refusedWith(proposeTeamFronts(h.deps, 'child', WS, ARGS), /only to the Team mode coordinator/);
      expect(h.posted, role).toEqual([]);
      expect(h.registry.size(), role).toBe(0);
    }
  });

  it('refuses a session that is not in team mode (solo, legacy metadata, no metadata)', async () => {
    for (const row of [
      { ...ROOT, metadata: {} },
      { ...ROOT, metadata: null },
      { ...ROOT, metadata: { teamMode: false } },
      { ...ROOT, metadata: { teamMode: 'true' } },
    ]) {
      const h = harness(row);
      await refusedWith(proposeTeamFronts(h.deps, 'solo', WS, ARGS), new RegExp(TEAM_FRONT_PROPOSE_ROOT_ONLY.slice(0, 40)));
      expect(h.posted).toEqual([]);
    }
  });

  it('refuses a meta-agent session even if it carries the team marker', async () => {
    const h = harness({ ...ROOT, agentRole: 'meta-agent' });
    await refusedWith(proposeTeamFronts(h.deps, 'meta', WS, ARGS), /only to the Team mode coordinator/);
  });

  it('refuses an archived root', async () => {
    const h = harness({ ...ROOT, isArchived: true });
    await refusedWith(proposeTeamFronts(h.deps, 'root', WS, ARGS), /archived/);
    expect(h.posted).toEqual([]);
  });

  it('fails closed when the session row is missing or cannot be read', async () => {
    await refusedWith(proposeTeamFronts(harness(null).deps, 'root', WS, ARGS), /could not be verified/);
    const h = harness(new Error('db'));
    await refusedWith(proposeTeamFronts(h.deps, 'root', WS, ARGS), /could not be verified/);
    expect(h.posted).toEqual([]);
  });

  it('refuses a session of another workspace', async () => {
    const h = harness({ ...ROOT, workspacePath: '/elsewhere' });
    await refusedWith(proposeTeamFronts(h.deps, 'root', WS, ARGS), /does not belong to this workspace/);
    const noPath = harness({ ...ROOT, workspacePath: null });
    await refusedWith(proposeTeamFronts(noPath.deps, 'root', WS, ARGS), /does not belong to this workspace/);
  });
});

describe('team_front_propose: arguments and rules (AC-2)', () => {
  it('refuses malformed arguments and registers nothing', async () => {
    for (const bad of [undefined, {}, { items: [] }, { items: [{ action: 'create', title: 'A', description: 'd', currentMission: 'x' }] }, { items: [{ action: 'create', title: 'A\nB', description: 'd' }] }]) {
      const h = harness(ROOT);
      await expect(proposeTeamFronts(h.deps, 'root', WS, bad)).rejects.toBeInstanceOf(TeamFrontProposalError);
      expect(h.posted).toEqual([]);
      expect(h.registry.size()).toBe(0);
    }
  });

  it('refuses a duplicate title (D2) and a status change of a missing front', async () => {
    const h = harness(ROOT, { fronts: [{ id: 'f1', title: 'portal', status: 'active' }] });
    await refusedWith(proposeTeamFronts(h.deps, 'root', WS, ARGS), /already exists/);
    await refusedWith(proposeTeamFronts(h.deps, 'root', WS, { items: [{ action: 'status', frontId: 'zzz', status: 'paused' }] }), /no team-front with id zzz/);
    expect(h.posted).toEqual([]);
    expect(h.registry.size()).toBe(0);
  });

  it('allows one pending proposal per root: the second call is refused until the first is settled', async () => {
    const h = harness(ROOT);
    await proposeTeamFronts(h.deps, 'root', WS, ARGS);
    await refusedWith(proposeTeamFronts(h.deps, 'root', WS, { items: [{ action: 'create', title: 'Other', description: 'd' }] }), /already waiting/);
    expect(h.posted).toHaveLength(1);
  });

  it('discards the proposal and refuses when the card cannot be shown', async () => {
    const h = harness(ROOT, { postFails: true });
    await refusedWith(proposeTeamFronts(h.deps, 'root', WS, ARGS), /card could not be shown/);
    expect(h.registry.size()).toBe(0);
    // the root is free to try again
    const retry = { ...h.deps, postCard: async () => undefined };
    await expect(proposeTeamFronts(retry, 'root', WS, ARGS)).resolves.toMatch(/awaiting_user_decision/);
  });
});

describe('team_front_propose: the accepted call', () => {
  it('registers the proposal for the root, shows the card and returns at once with nothing written', async () => {
    const h = harness({ ...ROOT, metadata: { teamMode: true, teamFront: 'f9' } }, { fronts: [{ id: 'f1', title: 'Billing', status: 'active' }] });
    const out = JSON.parse(await proposeTeamFronts(h.deps, 'root', WS, {
      items: [{ action: 'create', title: ' Portal ', description: 'Goal', status: 'paused' }, { action: 'status', frontId: 'f1', status: 'closed' }],
    }));
    expect(out).toMatchObject({ status: 'awaiting_user_decision', items: 2 });
    expect(out.proposalId).toMatch(/^tfp_/);
    const pending = h.registry.pendingForRoot('root')!;
    expect(pending).toMatchObject({ id: out.proposalId, rootSessionId: 'root', workspacePath: WS });
    expect(pending.items).toEqual([
      { action: 'create', title: 'Portal', description: 'Goal', status: 'paused' },
      { action: 'status', frontId: 'f1', status: 'closed', frontTitle: 'Billing', fromStatus: 'active', activeMission: null },
    ]);
    expect(h.posted).toEqual([pending]);
    // The agent is told not to wait and not to ask in chat; it gets no card text to echo.
    expect(out.note).toMatch(/Nothing has been created or changed/);
    expect(out.note).toMatch(/do not ask the user to approve it in chat/);
  });

  it('accepts a legacy (non-mission) root: team mode is the only requirement', async () => {
    const h = harness({ ...ROOT, agentRole: null });
    await expect(proposeTeamFronts(h.deps, 'root', WS, ARGS)).resolves.toMatch(/awaiting_user_decision/);
  });
});

describe('the proposal card row', () => {
  it('is a display-only tool_use row of TeamFrontProposal, not an interactive prompt, and carries plain data', async () => {
    const h = harness(ROOT);
    await proposeTeamFronts(h.deps, 'root', WS, ARGS);
    const proposal = h.registry.pendingForRoot('root')!;
    const rows: Array<{ sessionId: string; content: string; hidden: boolean }> = [];
    const notify = vi.fn();
    const deps: TeamFrontProposalCardDeps = {
      createMessage: async (row) => { rows.push(row); },
      notifyMessageLogged: notify,
      now: () => new Date('2026-10-28T12:00:00.000Z'),
    };
    await postTeamFrontProposalCard(proposal, deps);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessionId: 'root', hidden: false });
    expect(JSON.parse(rows[0].content)).toEqual({
      type: 'nimbalyst_tool_use',
      id: teamFrontProposalCardId(proposal.id),
      name: 'TeamFrontProposal',
      input: { proposalId: proposal.id, rootSessionId: 'root', items: [{ action: 'create', title: 'Portal', description: 'Goal and state.', status: 'active' }] },
    });
    expect(notify).toHaveBeenCalledWith('root', WS);
  });

  it('rejects when the row cannot be written (the caller then discards the proposal)', async () => {
    const h = harness(ROOT);
    await proposeTeamFronts(h.deps, 'root', WS, ARGS);
    const deps: TeamFrontProposalCardDeps = { createMessage: async () => { throw new Error('db'); }, notifyMessageLogged: vi.fn(), now: () => new Date() };
    await expect(postTeamFrontProposalCard(h.registry.pendingForRoot('root')!, deps)).rejects.toThrow('db');
  });
});

describe('team_front_propose on the host MCP server', () => {
  it('is declared with a closed item schema and no currentMission', () => {
    const def = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'team_front_propose')!;
    expect(def).toBeDefined();
    expect(def.inputSchema.required).toEqual(['items']);
    expect(Object.keys(def.inputSchema.properties)).toEqual(['items']);
    const item = (def.inputSchema.properties.items as { items: { additionalProperties: boolean; properties: Record<string, unknown> } }).items;
    expect(item.additionalProperties).toBe(false);
    expect(Object.keys(item.properties).sort()).toEqual(['action', 'description', 'frontId', 'status', 'title']);
    expect(def.description).toMatch(/returns immediately and writes nothing/);
  });

  it('dispatches with the caller session and the resolved workspace, whatever prefix it carries', async () => {
    const proposeTeamFrontsFn = vi.fn(async () => '{"status":"awaiting_user_decision"}');
    setMetaAgentToolFns({ proposeTeamFronts: proposeTeamFrontsFn } as never);
    await expect(dispatchMetaAgentTool('mcp__nimbalyst-host__team_front_propose', 'root-1', '/ws', ARGS)).resolves.toMatch(/awaiting/);
    expect(proposeTeamFrontsFn).toHaveBeenCalledWith('root-1', expect.any(String), ARGS);
  });
});
