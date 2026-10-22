// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

// The database poll is the fallback that sees a permission answer given from
// another device or session. The answer is the NEWEST row of the session, so the
// poll must read the newest rows. The repository double keeps the real store
// contract: list({ limit }) returns the OLDEST rows (ascending id + LIMIT) and
// listTail(n) returns the newest n rows in ascending order.
let rows: Array<{ id: number; content: string }> = [];

vi.mock('../../../../storage/repositories/AgentMessagesRepository', () => ({
  AgentMessagesRepository: {
    list: vi.fn(async (_sessionId: string, options?: { limit?: number }) => rows.slice(0, options?.limit ?? 50000)),
    listTail: vi.fn(async (_sessionId: string, limit: number) => rows.slice(-limit)),
  },
}));

import { ToolPermissionService } from '../ToolPermissionService';

function fillSession(count: number): void {
  for (let i = 0; i < count; i += 1) {
    rows.push({ id: rows.length + 1, content: JSON.stringify({ type: 'text', text: `turn chatter ${i}` }) });
  }
}

function answer(requestId: string): void {
  rows.push({
    id: rows.length + 1,
    content: JSON.stringify({
      type: 'nimbalyst_tool_result',
      tool_use_id: requestId,
      result: JSON.stringify({ decision: 'allow', scope: 'once' }),
    }),
  });
}

describe('permission database poll in a long session', () => {
  const controllers: AbortController[] = [];
  afterEach(() => {
    for (const controller of controllers) controller.abort();
    controllers.length = 0;
    rows = [];
  });

  function ask(service: ToolPermissionService, requestId: string) {
    const controller = new AbortController();
    controllers.push(controller);
    return service.requestToolPermission({
      requestId, sessionId: 'session', workspacePath: '/fixture', permissionsPath: '/fixture',
      toolName: 'Bash', toolInput: { command: 'npm test' }, pattern: 'Bash(npm test:*)',
      patternDisplayName: 'npm test', toolDescription: 'Run tests', isDestructive: false,
      signal: controller.signal,
    });
  }

  function newService() {
    return new ToolPermissionService({
      trustChecker: () => ({ trusted: true, mode: 'ask' }),
      patternSaver: vi.fn(),
      patternChecker: async () => false,
      emit: vi.fn(),
    });
  }

  it('finds an answer written after 80 earlier rows', async () => {
    fillSession(80);
    answer('request-long');

    const result = await Promise.race([
      ask(newService(), 'request-long'),
      new Promise((resolve) => setTimeout(() => resolve('not seen'), 1500)),
    ]);

    expect(result).toEqual({ decision: 'allow', scope: 'once' });
  });

  it('still finds an answer in a short session', async () => {
    fillSession(3);
    answer('request-short');

    const result = await Promise.race([
      ask(newService(), 'request-short'),
      new Promise((resolve) => setTimeout(() => resolve('not seen'), 1500)),
    ]);

    expect(result).toEqual({ decision: 'allow', scope: 'once' });
  });
});
