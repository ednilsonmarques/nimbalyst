// @vitest-environment node
/**
 * Display-only messages that used to be hard-coded English (top-bar git
 * feedback, attachment preflight errors, organization directory errors,
 * marketplace install progress, URL-permission descriptions, MCP OAuth errors,
 * alpha feature descriptions...). English must stay byte-identical to the
 * original literals; pt-BR must resolve to real text, never a raw key.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { i18n, setLanguage } from '@nimbalyst/runtime/i18n';
import { preflightAttachment } from '../renderer/services/conversationAttachments';
import { triggerMcpRemoteOAuth } from '../main/services/MCPRemoteOAuth';
import { ALPHA_FEATURES } from '../shared/alphaFeatures';

const RAW_KEY = /\b(workspace|general|editor|team|settings|system|common):|\b[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){2,}\b/;

/** [key, options, original English literal] */
const CASES: Array<[string, Record<string, unknown> | undefined, string]> = [
  ['workspace:topBar.git.pullCompleted', undefined, 'Pull completed'],
  ['workspace:topBar.git.pushCompleted', undefined, 'Push completed'],
  ['workspace:topBar.git.actionFailed', { action: 'pull' }, 'Git pull failed'],
  ['general:app.openWorkspaceToStart', undefined, 'Open a workspace to get started'],
  ['general:providerCredentials.changeFailed', undefined, 'Could not confirm the API key change. Unlock secure storage, refresh, and retry.'],
  ['editor:diff.fallbackSessionTitle', undefined, 'AI Session'],
  ['editor:collab.missingEditor.noEditor', { documentType: 'calc' }, 'No editor available for document type: calc'],
  ['team:userIndicator.noWorkspaceWindow', undefined, 'No workspace window is available for account settings.'],
  ['team:orgMode.directory.partialLoad', undefined, 'Some organizations could not be loaded. Retrying may restore the list.'],
  ['team:orgMode.directory.accountStatusFailed', undefined, 'Account status could not be loaded.'],
  ['team:orgMode.directory.accountsFailed', undefined, 'Accounts could not be loaded.'],
  ['team:comments.mention.agentSessionOf', { handle: 'bot', owner: 'Ada' }, '@bot · session of Ada'],
  ['team:shareToTeam.documentTypes.code', undefined, 'Text / Code'],
  ['team:shareToTeam.documentTypes.canvas', undefined, 'Project Canvas'],
  ['team:newDm.startFailed', undefined, 'Unable to start a direct message.'],
  ['team:sidebar.organization', undefined, 'Organization'],
  ['team:projects.loadFailedShort', undefined, 'Could not load projects'],
  ['settings:organization.identity.renameFailed', undefined, 'Could not rename organization'],
  ['settings:projectPermissions.errors.load', undefined, 'Failed to load workspace permissions'],
  ['settings:projectPermissions.urls.allowFetchingFrom', { domain: 'example.com' }, 'Allow fetching from example.com'],
  ['settings:projectPermissions.urls.allUrlsAllowed', undefined, 'All URLs allowed'],
  ['settings:marketplace.progress.installing', { id: 'acme-ext' }, 'Installing acme-ext...'],
  ['settings:marketplace.progress.checkingRelease', undefined, 'Checking for release artifact...'],
  ['settings:marketplace.progress.downloadingRelease', { asset: 'ext.nimext', tag: 'v1.2.0' }, 'Downloading ext.nimext (v1.2.0)...'],
  ['settings:marketplace.progress.installedFromRelease', { id: 'acme-ext', tag: 'v1.2.0' }, 'Installed acme-ext from release v1.2.0'],
  ['settings:marketplace.progress.cloningSource', undefined, 'No release artifact found, cloning source...'],
  ['settings:marketplace.progress.installedFromSource', { id: 'acme-ext' }, 'Installed acme-ext from source'],
  ['settings:providers.openAiCodex.cliUnavailable', undefined, 'Codex CLI is unavailable.'],
  ['system:mcpOAuth.errors.processExitWithCode', { exitCode: 3 }, 'The OAuth helper exited before authorization completed (exit code 3).'],
  ['system:mcpOAuth.commandNotFound.npx', undefined, "Command 'npx' not found. Node.js needs to be installed to use this MCP server."],
  ['system:mcpOAuth.commandNotFound.generic', { command: 'uvx' }, "Command 'uvx' not found. Please ensure it is installed and available in your PATH."],
];

afterEach(async () => {
  await setLanguage('en');
});

describe('display messages i18n', () => {
  it('keeps every English message byte-identical to the original literal', async () => {
    await setLanguage('en');
    for (const [key, options, english] of CASES) {
      expect(i18n.t(key, options), key).toBe(english);
    }
  });

  it('resolves every message in pt-BR without leaking a raw key', async () => {
    await setLanguage('pt-BR');
    for (const [key, options, english] of CASES) {
      const translated = i18n.t(key, options);
      expect(translated, key).not.toMatch(RAW_KEY);
      // Brand/product names may stay; everything else must actually change.
      if (key !== 'team:shareToTeam.documentTypes.canvas') {
        expect(translated, key).not.toBe(english);
      }
      for (const value of Object.values(options ?? {})) {
        expect(translated, key).toContain(String(value));
      }
    }
  });

  it('keeps the alpha feature descriptions in sync with the shared registry', async () => {
    await setLanguage('en');
    const keys: Record<string, string> = {
      'super-loops': 'settings:agentFeatures.alpha.superLoops',
      blitz: 'settings:agentFeatures.alpha.blitz',
      'meta-agent': 'settings:agentFeatures.alpha.metaAgent',
    };
    for (const feature of ALPHA_FEATURES) {
      expect(i18n.t(keys[feature.tag]), feature.tag).toBe(feature.description);
    }
    await setLanguage('pt-BR');
    for (const feature of ALPHA_FEATURES) {
      const translated = i18n.t(keys[feature.tag]);
      expect(translated).not.toBe(feature.description);
      expect(translated).not.toMatch(RAW_KEY);
    }
  });

  it('localizes attachment preflight errors but keeps the error codes', async () => {
    const empty = { name: 'notes.txt', size: 0, type: 'text/plain' };
    await setLanguage('en');
    expect(preflightAttachment(empty)).toEqual({ ok: false, code: 'empty', message: 'notes.txt is empty.' });
    const tooLarge = preflightAttachment({ name: 'clip.mov', size: 500 * 1024 * 1024, type: 'video/quicktime' });
    expect(tooLarge.ok === false && tooLarge.code).toBe('tooLarge');
    expect(tooLarge.ok === false && tooLarge.message).toMatch(/^clip\.mov is .+\. Attachments are limited to .+\.$/);

    await setLanguage('pt-BR');
    expect(preflightAttachment(empty)).toEqual({ ok: false, code: 'empty', message: 'notes.txt está vazio.' });
    const ptTooLarge = preflightAttachment({ name: 'clip.mov', size: 500 * 1024 * 1024, type: 'video/quicktime' });
    expect(ptTooLarge.ok === false && ptTooLarge.code).toBe('tooLarge');
    expect(ptTooLarge.ok === false && ptTooLarge.message).toMatch(/^clip\.mov tem .+\. Os anexos são limitados a .+\.$/);
  });

  it('localizes the MCP OAuth error message but not the error type', async () => {
    const invalid = { type: 'http', url: '' } as never;
    await setLanguage('en');
    const en = await triggerMcpRemoteOAuth(invalid);
    expect(en).toMatchObject({ success: false, errorType: 'invalid_config', error: 'Invalid OAuth configuration.' });

    await setLanguage('pt-BR');
    const pt = await triggerMcpRemoteOAuth(invalid);
    expect(pt).toMatchObject({ success: false, errorType: 'invalid_config', error: 'Configuração OAuth inválida.' });
  });
});
