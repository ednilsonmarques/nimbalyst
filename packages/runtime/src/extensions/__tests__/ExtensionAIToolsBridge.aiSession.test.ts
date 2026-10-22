// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import {
  executeExtensionTool,
  registerExtensionTools,
  unregisterExtensionTools,
} from '../ExtensionAIToolsBridge';
import type { LoadedExtension } from '../types';

function makeExtension(tools: LoadedExtension['module']['aiTools']): LoadedExtension {
  const manifest = { id: 'com.test.fixture', name: 'Fixture', version: '0.0.0', main: 'index.js' };
  return {
    manifest,
    module: { aiTools: tools },
    context: {
      manifest,
      extensionPath: '/tmp/fixture',
      services: {} as LoadedExtension['context']['services'],
      subscriptions: [],
    },
    enabled: true,
    dispose: async () => {},
  };
}

describe('ExtensionAIToolsBridge AI session attribution', () => {
  afterEach(() => unregisterExtensionTools('com.test.fixture'));

  it('hands the calling AI session id to the tool through AIToolContext', async () => {
    let seen: string | undefined = 'unset';
    registerExtensionTools(makeExtension([
      {
        name: 'who',
        description: 'Report the caller',
        access: { kind: 'filesystem' },
        handler: async (_params, context) => {
          seen = context.aiSessionId;
          return { success: true };
        },
      },
    ]));

    await executeExtensionTool('fixture.who', {}, { workspacePath: '/ws', aiSessionId: 'ai-session-A' });
    expect(seen).toBe('ai-session-A');
  });

  it('leaves aiSessionId undefined for callers that are not an AI session', async () => {
    let seen: string | undefined = 'unset';
    registerExtensionTools(makeExtension([
      {
        name: 'who',
        description: 'Report the caller',
        access: { kind: 'filesystem' },
        handler: async (_params, context) => {
          seen = context.aiSessionId;
          return { success: true };
        },
      },
    ]));

    await executeExtensionTool('fixture.who', {}, { workspacePath: '/ws' });
    expect(seen).toBeUndefined();
  });

  it('does not let tool arguments set the attribution', async () => {
    let seen: string | undefined = 'unset';
    registerExtensionTools(makeExtension([
      {
        name: 'who',
        description: 'Report the caller',
        access: { kind: 'filesystem' },
        handler: async (_params, context) => {
          seen = context.aiSessionId;
          return { success: true };
        },
      },
    ]));

    await executeExtensionTool('fixture.who', { aiSessionId: 'ai-session-B' }, { workspacePath: '/ws', aiSessionId: 'ai-session-A' });
    expect(seen).toBe('ai-session-A');
  });
});
