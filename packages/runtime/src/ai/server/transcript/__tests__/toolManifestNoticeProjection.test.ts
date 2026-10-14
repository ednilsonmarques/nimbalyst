/**
 * The Tool Manifest notice (Phase 1B) is a host-written queued prompt with
 * `promptOrigin: 'tool_manifest'` (see the electron services/team/toolManifests.ts).
 * This runs it through the real Claude Code transcript projection: a system
 * status line of its own kind, never a "You" message, and not searchable.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { projectRawMessagesToViewMessages } from '../projectRawMessages';
import type { RawMessage } from '../TranscriptTransformer';
import { extractSearchable } from '../searchableTextExtractor';
import { TOOL_MANIFEST_PROMPT_ORIGIN } from '../../providers/teamContext';

const ROOT = 'root-session';
const NOTICE = '[Tool Manifest] M-1 from the architect (session arch-1) is stored as tracker item NIB.31 (confidence: high).';
const provenance = { actor: 'system', origin: 'session-orchestration', messageKind: 'status' };
const input = (metadata: Record<string, unknown>): RawMessage => ({
  id: 10, sessionId: ROOT, source: 'claude-code', direction: 'input',
  content: JSON.stringify({ prompt: NOTICE, options: {} }), createdAt: new Date('2026-10-13T18:00:01Z'), metadata,
});

describe('Tool Manifest notice projection', () => {
  it('is a system status message of the tool_manifest kind, not a user message', async () => {
    const [message, ...rest] = await projectRawMessagesToViewMessages(
      [input({ promptOrigin: TOOL_MANIFEST_PROMPT_ORIGIN, promptProvenance: provenance, mode: 'agent' })], 'claude-code',
    );
    expect(rest).toHaveLength(0);
    expect(message.type).toBe('system_message');
    expect(message.systemMessage).toMatchObject({ systemType: 'status', reminderKind: TOOL_MANIFEST_PROMPT_ORIGIN });
    expect(message.text).toBe(NOTICE);
  });

  it('without that origin the same prompt is an ordinary user message', async () => {
    const [message] = await projectRawMessagesToViewMessages([input({ promptProvenance: provenance, mode: 'agent' })], 'claude-code');
    expect(message.type).toBe('user_message');
  });

  it('is not searchable, like the other host notices', () => {
    const noticeRow = input({ promptOrigin: TOOL_MANIFEST_PROMPT_ORIGIN, promptProvenance: provenance, mode: 'agent' });
    const plainRow = input({ promptProvenance: provenance, mode: 'agent' });
    const searchable = (row: RawMessage) => extractSearchable({
      content: row.content, direction: row.direction, source: row.source, metadata: row.metadata as Record<string, unknown> | null,
    });
    expect(searchable(noticeRow)).toEqual({ searchableText: null, messageKind: 'system' });
    expect(searchable(plainRow).searchableText).toContain('Tool Manifest');
    expect(searchable(plainRow).messageKind).toBe('user');
  });

  it('has its label and text in both UI languages', () => {
    const locales = path.resolve(__dirname, '../../../../i18n/locales');
    const en = JSON.parse(readFileSync(path.join(locales, 'en', 'ai.json'), 'utf8')).toolManifest;
    const pt = JSON.parse(readFileSync(path.join(locales, 'pt-BR', 'ai.json'), 'utf8')).toolManifest;
    // `card` (Phase 1C) holds the Tool Manifest card's nested keys; parity of nested keys is check:i18n's job.
    expect(Object.keys(en).sort()).toEqual(['card', 'notice', 'noticeLabel', 'noticeRenumbered', 'noticeSupersedeFailed', 'noticeSuperseded']);
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      if (typeof en[key] !== 'string') continue;
      const placeholders = (text: string) => (text.match(/\{\{\w+\}\}/g) ?? []).sort();
      expect(placeholders(pt[key]), key).toEqual(placeholders(en[key]));
    }
    expect(en.notice).not.toContain('toolManifest: 1');
  });
});
