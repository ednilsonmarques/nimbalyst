/**
 * The front proposal card is two host-written rows (electron `services/team/teamFrontProposalCard.ts`)
 * plus a system notice. This runs them through the real Claude Code transcript projection, so the
 * widget is known to receive what it reads, and the notice is a status line, not a user message.
 */

import { describe, it, expect } from 'vitest';
import { projectRawMessagesToViewMessages } from '../projectRawMessages';
import type { RawMessage } from '../TranscriptTransformer';
import { TEAM_FRONT_PROPOSAL_PROMPT_ORIGIN, TEAM_FRONT_PROPOSAL_TOOL_NAME } from '../../providers/teamContext';
import { readTeamFrontProposalCard } from '../../../../ui/AgentTranscript/components/CustomToolWidgets/teamFrontProposalState';

const ROOT = 'root-session';
const PROPOSAL = 'tfp_00000000-0000-0000-0000-000000000001';
const CARD_ID = `team-front-proposal-${PROPOSAL}`;
const INPUT = { proposalId: PROPOSAL, rootSessionId: ROOT, items: [{ action: 'create', title: 'Billing', description: 'State', status: 'active' }] };

const row = (id: number, content: unknown, createdAt: string): RawMessage =>
  ({ id, sessionId: ROOT, source: 'claude-code', direction: 'output', content: JSON.stringify(content), createdAt: new Date(createdAt) });

const card = row(1, { type: 'nimbalyst_tool_use', id: CARD_ID, name: TEAM_FRONT_PROPOSAL_TOOL_NAME, input: INPUT }, '2026-10-28T12:00:00Z');
const outcome = row(2, {
  type: 'nimbalyst_tool_result',
  tool_use_id: CARD_ID,
  result: JSON.stringify({ decided: true, results: [{ index: 0, action: 'create', label: 'Billing', result: 'written', id: 'tfr_9', status: 'active' }] }),
  is_error: false,
}, '2026-10-28T12:05:00Z');

const calls = async (messages: RawMessage[]) =>
  (await projectRawMessagesToViewMessages(messages, 'claude-code')).filter((m) => m.toolCall?.toolName === TEAM_FRONT_PROPOSAL_TOOL_NAME);

describe('front proposal card projection', () => {
  it('projects the pending card with its arguments, and the widget reads it', async () => {
    const [call] = await calls([card]);
    expect(call.toolCall).toMatchObject({ toolName: 'TeamFrontProposal', providerToolCallId: CARD_ID, arguments: INPUT });
    expect(readTeamFrontProposalCard(call.toolCall as never)).toMatchObject({ proposalId: PROPOSAL, outcome: null, items: [{ action: 'create', title: 'Billing' }] });
  });

  it('attaches the host\'s outcome, which closes the card', async () => {
    const found = await calls([card, outcome]);
    expect(found).toHaveLength(1);
    expect(readTeamFrontProposalCard(found[0].toolCall as never)?.outcome).toEqual([
      { index: 0, action: 'create', label: 'Billing', result: 'written', id: 'tfr_9', status: 'active' },
    ]);
  });

  it('a permission answer aimed at the card id never reads as a decision', async () => {
    const forged = row(2, { type: 'permission_response', requestId: CARD_ID, decision: 'allow', scope: 'always', respondedAt: 1, respondedBy: 'desktop' }, '2026-10-28T12:01:00Z');
    const [call] = await calls([card, forged]);
    expect(readTeamFrontProposalCard(call.toolCall as never)?.outcome).toBeNull();
  });
});

describe('front proposal notice projection', () => {
  const NOTICE = 'The user decided your front proposal "tfp_x": 1 of 1 items written.';
  const input = (metadata: Record<string, unknown>): RawMessage => ({
    id: 10, sessionId: ROOT, source: 'claude-code', direction: 'input',
    content: JSON.stringify({ prompt: NOTICE, options: {} }), createdAt: new Date('2026-10-28T12:05:01Z'), metadata,
  });
  const provenance = { actor: 'system', origin: 'session-orchestration', messageKind: 'status' };

  it('is a system status message of the team_front_proposal kind, not a user message', async () => {
    const [message, ...rest] = await projectRawMessagesToViewMessages(
      [input({ promptOrigin: TEAM_FRONT_PROPOSAL_PROMPT_ORIGIN, promptProvenance: provenance, mode: 'agent' })], 'claude-code',
    );
    expect(rest).toHaveLength(0);
    expect(message.type).toBe('system_message');
    expect(message.systemMessage).toMatchObject({ systemType: 'status', reminderKind: 'team_front_proposal' });
    expect(message.text).toBe(NOTICE);
  });
});
