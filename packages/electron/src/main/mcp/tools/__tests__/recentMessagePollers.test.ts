import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The permission and commit-proposal polls, and the Codex tool-call lookup, all
// need the newest rows of the session: the user's answer, or the current turn.
// AgentMessagesRepository.list({ limit }) returns the OLDEST rows, so in a long
// session they would never see them. They must read with listTail.
const FILES = ['interactiveToolHandlers.ts', 'codexToolCallResolver.ts'];

// Any list() call at all: these files have no reason to read the oldest rows.
const ANY_LIST_CALL = /AgentMessagesRepository\.list\(/;

describe('MCP tool pollers read the newest session rows', () => {
  it.each(FILES)('%s never reads the oldest rows with list()', (file) => {
    const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
    expect(source).not.toMatch(ANY_LIST_CALL);
    expect(source).toMatch(/AgentMessagesRepository\.listTail\(/);
  });
});
