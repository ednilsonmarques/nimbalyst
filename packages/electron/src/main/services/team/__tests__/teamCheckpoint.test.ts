// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AgentMessagesRepository', () => ({ AgentMessagesRepository: {} }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: { query: vi.fn() } }));

import {
  TEAM_CONTINUATION_NOTICE_CONTEXT,
  buildTeamContinuationNotice,
  postTeamCheckpointCard,
  resolveTeamCheckpointCard,
  teamCheckpointCardId,
  teamContinueActionLabel,
  type TeamCheckpointDeps,
} from '../teamCheckpoint';

const NOW = new Date('2026-10-12T12:00:00.000Z');

function harness(existing: string[] = []) {
  const rows: Array<{ sessionId: string; source: string; direction: string; content: string; hidden: boolean; createdAt: Date }> = [];
  const notifyMessageLogged = vi.fn();
  const deps: TeamCheckpointDeps = {
    hasCard: async (_root, cardId) => existing.includes(cardId) || rows.some((row) => row.content.includes(`"id":"${cardId}"`)),
    createMessage: async (row) => { rows.push(row); },
    notifyMessageLogged,
    now: () => NOW,
  };
  return { rows, notifyMessageLogged, deps };
}

const card = { rootSessionId: 'root', workspacePath: '/ws', created: 8, authorized: 8 };

describe('Team checkpoint card', () => {
  it('posts the card in the root transcript with what the user needs to decide', async () => {
    const h = harness();
    await postTeamCheckpointCard(card, h.deps);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ sessionId: 'root', source: 'claude-code', direction: 'output', hidden: false, createdAt: NOW });
    expect(JSON.parse(h.rows[0].content)).toEqual({
      type: 'nimbalyst_tool_use',
      id: 'team-checkpoint-root-8',
      name: 'TeamCheckpoint',
      input: { rootSessionId: 'root', created: 8, authorized: 8, extension: 4, maxActive: 3 },
    });
    expect(h.notifyMessageLogged).toHaveBeenCalledWith('root', '/ws');
  });

  it('posts one card per authorized level, however many creations are refused', async () => {
    const h = harness();
    await postTeamCheckpointCard(card, h.deps);
    await postTeamCheckpointCard(card, h.deps);
    await postTeamCheckpointCard({ ...card, created: 12, authorized: 12 }, h.deps);
    expect(h.rows.map((row) => JSON.parse(row.content).id)).toEqual(['team-checkpoint-root-8', 'team-checkpoint-root-12']);
    expect(h.notifyMessageLogged).toHaveBeenCalledTimes(2);
  });

  it('does not post again a card already in the transcript (after a restart)', async () => {
    const h = harness([teamCheckpointCardId('root', 8)]);
    await postTeamCheckpointCard(card, h.deps);
    expect(h.rows).toHaveLength(0);
    expect(h.notifyMessageLogged).not.toHaveBeenCalled();
  });

  it('never throws: the refusal the model gets must not be replaced by a card failure', async () => {
    const h = harness();
    const failing: TeamCheckpointDeps = { ...h.deps, createMessage: async () => { throw new Error('db down'); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(postTeamCheckpointCard(card, failing)).resolves.toBeUndefined();
    await expect(resolveTeamCheckpointCard({ ...card, previousAuthorized: 8, authorized: 12 }, failing)).resolves.toBeUndefined();
    warn.mockRestore();
  });

  it('resolves the card of the level the user continued from', async () => {
    const h = harness();
    await resolveTeamCheckpointCard({ rootSessionId: 'root', workspacePath: '/ws', previousAuthorized: 8, authorized: 12 }, h.deps);
    const content = JSON.parse(h.rows[0].content);
    expect(content).toMatchObject({ type: 'nimbalyst_tool_result', tool_use_id: 'team-checkpoint-root-8', is_error: false });
    expect(JSON.parse(content.result)).toEqual({ continued: true, authorized: 12 });
    expect(h.notifyMessageLogged).toHaveBeenCalledWith('root', '/ws');
  });

  it('tells the coordinator the new total and that the other limits did not move', () => {
    const notice = buildTeamContinuationNotice({ total: 8, authorized: 12 });
    expect(notice.startsWith('[Team checkpoint]')).toBe(true);
    expect(notice).toContain('up to 12 sessions in total (8 created so far)');
    expect(notice).toContain('3 active sessions at once and 2 levels of depth are unchanged');
  });
});

describe('Team checkpoint texts follow the UI language', () => {
  afterEach(async () => {
    await setLanguage('en');
  });

  it('names the action as the button the user sees: Continue team / Continuar equipe', async () => {
    expect(teamContinueActionLabel()).toBe('Continue team');
    await setLanguage('pt-BR');
    expect(teamContinueActionLabel()).toBe('Continuar equipe');
  });

  it('writes the continuation notice in pt-BR when the UI is in pt-BR', async () => {
    await setLanguage('pt-BR');
    const notice = buildTeamContinuationNotice({ total: 8, authorized: 12 });
    expect(notice.startsWith('[Checkpoint da equipe]')).toBe(true);
    expect(notice).toContain('O usuário autorizou a continuação');
    expect(notice).toContain('até 12 sessões no total (8 criadas até aqui)');
    expect(notice).toContain('3 sessões ativas ao mesmo tempo e 2 níveis de profundidade não mudaram');
    expect(notice).not.toMatch(/Team checkpoint|The user authorized|\{\{/);
  });

  it('queues the notice as system orchestration with its own origin, never as a human prompt', () => {
    expect(TEAM_CONTINUATION_NOTICE_CONTEXT).toEqual({
      promptOrigin: 'team_checkpoint',
      promptProvenance: { actor: 'system', origin: 'session-orchestration', messageKind: 'status' },
    });
  });
});
