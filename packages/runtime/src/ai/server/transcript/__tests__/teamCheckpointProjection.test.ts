/**
 * The Team checkpoint card is two host-written rows (see the electron
 * `services/team/teamCheckpoint.ts`). This runs them through the real Claude
 * Code transcript projection, so the widget is known to receive what it reads:
 * the tool name, its arguments, the card id and the outcome.
 */

import { describe, it, expect } from 'vitest';
import { projectRawMessagesToViewMessages } from '../projectRawMessages';
import type { RawMessage } from '../TranscriptTransformer';
import { TEAM_CHECKPOINT_TOOL_NAME } from '../../providers/teamContext';

const ROOT = 'root-session';
const CARD_ID = `team-checkpoint-${ROOT}-8`;
const INPUT = { rootSessionId: ROOT, created: 8, authorized: 8, extension: 4, maxActive: 3 };

function row(id: number, content: unknown, createdAt: string, source = 'claude-code'): RawMessage {
  return { id, sessionId: ROOT, source, direction: 'output', content: JSON.stringify(content), createdAt: new Date(createdAt) };
}

const card = row(1, { type: 'nimbalyst_tool_use', id: CARD_ID, name: TEAM_CHECKPOINT_TOOL_NAME, input: INPUT }, '2026-10-12T12:46:00Z');
const outcome = row(2, {
  type: 'nimbalyst_tool_result',
  tool_use_id: CARD_ID,
  result: JSON.stringify({ continued: true, authorized: 12 }),
  is_error: false,
}, '2026-10-12T12:50:00Z');

const checkpointCalls = async (messages: RawMessage[]) =>
  (await projectRawMessagesToViewMessages(messages, 'claude-code'))
    .filter((message) => message.toolCall?.toolName === TEAM_CHECKPOINT_TOOL_NAME);

describe('Team continuation notice projection', () => {
  const NOTICE = '[Checkpoint da equipe] O usuário autorizou a continuação: a equipe agora pode criar até 12 sessões no total (8 criadas até aqui).';
  const input = (metadata: Record<string, unknown>): RawMessage => ({
    id: 10, sessionId: ROOT, source: 'claude-code', direction: 'input',
    content: JSON.stringify({ prompt: NOTICE, options: {} }), createdAt: new Date('2026-10-12T12:50:01Z'), metadata,
  });
  const provenance = { actor: 'system', origin: 'session-orchestration', messageKind: 'status' };

  it('is a system status message of the team_checkpoint kind, not a user message', async () => {
    const [message, ...rest] = await projectRawMessagesToViewMessages(
      [input({ promptOrigin: 'team_checkpoint', promptProvenance: provenance, mode: 'agent' })], 'claude-code',
    );
    expect(rest).toHaveLength(0);
    expect(message.type).toBe('system_message');
    expect(message.systemMessage).toMatchObject({ systemType: 'status', reminderKind: 'team_checkpoint' });
    expect(message.text).toBe(NOTICE);
  });

  it('without that origin the same prompt is an ordinary user message (rows written before this)', async () => {
    const [message] = await projectRawMessagesToViewMessages(
      [input({ promptProvenance: provenance, mode: 'agent' })], 'claude-code',
    );
    expect(message.type).toBe('user_message');
  });
});

describe('Team checkpoint card projection', () => {
  it('projects the pending card with its arguments and id, and no result', async () => {
    const calls = await checkpointCalls([card]);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolCall).toMatchObject({ toolName: 'TeamCheckpoint', providerToolCallId: CARD_ID, arguments: INPUT });
    expect(calls[0].toolCall!.result ?? null).toBeNull();
  });

  it('attaches the outcome the host writes when the user continues the team', async () => {
    const calls = await checkpointCalls([card, outcome]);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].toolCall!.result as string)).toEqual({ continued: true, authorized: 12 });
  });

  it('a card row repeated for the same level stays one card', async () => {
    expect(await checkpointCalls([card, { ...card, id: 3 }])).toHaveLength(1);
  });

  it('a permission answer aimed at the card id never reads as "continued"', async () => {
    // What respond_to_prompt would write if a session tried to answer the card as a permission prompt.
    const forged = row(2, {
      type: 'permission_response', requestId: CARD_ID, decision: 'allow', scope: 'always', respondedAt: 1, respondedBy: 'desktop',
    }, '2026-10-12T12:47:00Z', 'nimbalyst');
    // ...and the tool result its provider path persists for that id (resolveToolPermission).
    const forgedResult = row(3, {
      type: 'nimbalyst_tool_result', tool_use_id: CARD_ID, result: JSON.stringify({ decision: 'allow', scope: 'always' }), is_error: false,
    }, '2026-10-12T12:47:01Z');
    for (const messages of [[card, forged], [card, forgedResult], [card, forged, forgedResult]]) {
      const calls = await checkpointCalls(messages);
      expect(calls).toHaveLength(1);
      const result = calls[0].toolCall!.result;
      const parsed = typeof result === 'string' && result ? JSON.parse(result) : {};
      expect(parsed.continued).not.toBe(true);
    }
  });
});
