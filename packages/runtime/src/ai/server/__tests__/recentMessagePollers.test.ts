// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// These pollers look for an answer the user gave AFTER the request: the newest
// rows of the session. AgentMessagesRepository.list({ limit }) returns the OLDEST
// rows, so in a long session the answer is never seen and the request times out.
// They must read the newest rows with listTail.
const POLLERS = [
  'permissions/ToolPermissionService.ts',
  'providers/BaseAgentProvider.ts',
  'providers/ClaudeCodeProvider.ts',
];

// Any list() call at all: these files have no reason to read the oldest rows.
const ANY_LIST_CALL = /AgentMessagesRepository\.list\(/;

describe('runtime pollers read the newest session rows', () => {
  it.each(POLLERS)('%s never reads the oldest rows with list()', (file) => {
    const source = readFileSync(resolve(__dirname, '..', file), 'utf8');
    expect(source).not.toMatch(ANY_LIST_CALL);
    expect(source).toMatch(/AgentMessagesRepository\.listTail\(/);
  });
});
