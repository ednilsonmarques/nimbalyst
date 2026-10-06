// @vitest-environment node
/** Main-process notification fallbacks and MCP test messages resolve in the active UI language. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TeamInboxMaterializedDelivery } from '@nimbalyst/runtime/sync';
import { asTeamMemberId } from '@nimbalyst/runtime/auth/jwtScopes';
import { setLanguage } from '@nimbalyst/runtime/i18n';

import {
  TeamInboxNotificationService,
  type TeamInboxNativeNotification,
} from '../TeamInboxNotificationService';
import { getCommandNotFoundHelp } from '../MCPConfigService';
import { buildTurnNotificationBody } from '../ai/claudeCliTurnNotification';

afterEach(async () => {
  await setLanguage('en');
});

function delivery(): TeamInboxMaterializedDelivery {
  return {
    id: 'delivery-1',
    teamMemberId: asTeamMemberId('member-viewer'),
    orgId: 'org-a',
    orgName: 'Acme',
    source: {
      orgId: 'org-a',
      sourceKind: 'roomMessage',
      sourceId: 'conversation-general',
      commentId: 'message-1',
    },
    reason: 'mention',
    actor: { kind: 'user', userId: 'member-sender', onBehalfOfUserId: 'member-sender' },
    preview: { snippet: '' },
    createdAt: 100,
    hasUnreadActivity: false,
  };
}

async function notifyWithoutLabels(): Promise<TeamInboxNativeNotification> {
  const shown: TeamInboxNativeNotification[] = [];
  const service = new TeamInboxNotificationService({
    notificationsEnabled: () => true,
    notificationsSupported: () => true,
    isConversationFocused: () => false,
    showNativeNotification: (notification) => {
      shown.push(notification);
    },
    openConversation: vi.fn(),
    openInbox: vi.fn(),
    openInboxSource: vi.fn(async () => true),
    resolveConversationTitle: vi.fn(async () => null),
    resolveMemberLabel: vi.fn(async () => null),
  });
  await service.notify(delivery());
  expect(shown).toHaveLength(1);
  return shown[0];
}

describe('team inbox notification fallbacks i18n', () => {
  it('keeps the English fallback title and body', async () => {
    const shown = await notifyWithoutLabels();
    expect(shown.title).toBe('Acme · Room');
    expect(shown.body).toBe('A teammate: New activity');
  });

  it('renders the fallbacks in pt-BR', async () => {
    await setLanguage('pt-BR');
    const shown = await notifyWithoutLabels();
    expect(shown.title).toBe('Acme · Sala');
    expect(shown.body).toBe('Um colega de equipe: Nova atividade');
  });
});

describe('MCP command-not-found help', () => {
  it('keeps the English messages byte-identical', () => {
    expect(getCommandNotFoundHelp('npx.cmd').message).toBe(
      "Command 'npx' not found. Node.js needs to be installed to use this MCP server.",
    );
    expect(getCommandNotFoundHelp('uvx').message).toBe(
      "Command 'uvx' not found. Please install uv to use this MCP server.",
    );
    expect(getCommandNotFoundHelp('docker').message).toBe(
      "Command 'docker' not found. Docker Desktop needs to be installed to use this MCP server.",
    );
    expect(getCommandNotFoundHelp('foo')).toEqual({
      message: "Command 'foo' not found. Please ensure it is installed and available in your PATH.",
    });
  });

  it('stays English in pt-BR: MCPServersPanel categorizes it for telemetry by English substrings', async () => {
    await setLanguage('pt-BR');
    expect(getCommandNotFoundHelp('python3')).toEqual({
      message: "Command 'python3' not found. Python needs to be installed to use this MCP server.",
      helpUrl: 'https://www.python.org/downloads/',
    });
    expect(getCommandNotFoundHelp('foo').message).toContain('not found');
  });
});

describe('turn notification body i18n', () => {
  it('uses the localized empty-response body', async () => {
    expect(buildTurnNotificationBody('  ')).toBe('Response complete');
    await setLanguage('pt-BR');
    expect(buildTurnNotificationBody('  ')).toBe('Resposta concluída');
    expect(buildTurnNotificationBody('Done')).toBe('Done');
  });
});
