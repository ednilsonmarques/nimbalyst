// @vitest-environment node
/**
 * F1.1 S3b (NIB.186): renderer_eval is denied to every Team mode session, root and
 * members, on any provider, by the extension-dev server itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  RENDERER_EVAL_TEAM_REFUSAL,
  RENDERER_EVAL_UNVERIFIED_REFUSAL,
  rendererEvalSessionRefusal,
} from '../rendererEvalSessionGuard';

const row = (metadata: unknown, agentRole: string | null = 'standard') => async () => ({ metadata, agentRole });

describe('rendererEvalSessionRefusal', () => {
  it('refuses a Team mode root', async () => {
    expect(await rendererEvalSessionRefusal('root', row({ teamMode: true }))).toBe(RENDERER_EVAL_TEAM_REFUSAL);
    expect(await rendererEvalSessionRefusal('mission-root', row({ teamMode: true, teamFront: 'tfr_1', teamMissionStatus: 'active' }))).toBe(RENDERER_EVAL_TEAM_REFUSAL);
  });

  it('refuses a member of every role', async () => {
    for (const role of ['explorer', 'implementer', 'reviewer', 'architect', 'advisor', 'other']) {
      expect(await rendererEvalSessionRefusal('child', row({ teamChild: { rootSessionId: 'root', depth: 1, role } })), role).toBe(RENDERER_EVAL_TEAM_REFUSAL);
    }
  });

  it('lets a non-team session through (the development gate is separate and still applies)', async () => {
    expect(await rendererEvalSessionRefusal('solo', row({}))).toBeNull();
    expect(await rendererEvalSessionRefusal('solo', row(null))).toBeNull();
    expect(await rendererEvalSessionRefusal('solo', row({ teamMode: false }))).toBeNull();
    expect(await rendererEvalSessionRefusal('meta', row({ teamMode: true }, 'meta-agent'))).toBeNull();
  });

  it('fails closed when a named session cannot be resolved', async () => {
    expect(await rendererEvalSessionRefusal('ghost', async () => null)).toBe(RENDERER_EVAL_UNVERIFIED_REFUSAL);
    expect(await rendererEvalSessionRefusal('ghost', async () => undefined)).toBe(RENDERER_EVAL_UNVERIFIED_REFUSAL);
    expect(await rendererEvalSessionRefusal('ghost', async () => { throw new Error('db'); })).toBe(RENDERER_EVAL_UNVERIFIED_REFUSAL);
  });

  it('retries a failed read once before refusing, and a recovered read is judged normally', async () => {
    const reader = vi.fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValueOnce({ metadata: { teamMode: true }, agentRole: 'standard' });
    expect(await rendererEvalSessionRefusal('root', reader)).toBe(RENDERER_EVAL_TEAM_REFUSAL);
    expect(reader).toHaveBeenCalledTimes(2);
    const solo = vi.fn().mockRejectedValueOnce(new Error('blip')).mockResolvedValueOnce({ metadata: {}, agentRole: 'standard' });
    expect(await rendererEvalSessionRefusal('solo', solo)).toBeNull();
  });

  it('a request that names no session keeps today\'s behaviour', async () => {
    const reader = vi.fn();
    expect(await rendererEvalSessionRefusal(undefined, reader)).toBeNull();
    expect(await rendererEvalSessionRefusal('', reader)).toBeNull();
    expect(reader).not.toHaveBeenCalled();
  });
});

describe('the extension-dev server applies it', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../extensionDevServer.ts'), 'utf8');
  const block = source.slice(source.indexOf('case "renderer_eval": {'), source.indexOf('case "extension_test_ai_tool": {'));

  it('the renderer_eval handler asks the guard with the connection\'s session before it does anything else', () => {
    expect(block).toMatch(/rendererEvalSessionRefusal\(callingAiSessionId\)/);
    expect(block.indexOf('rendererEvalSessionRefusal(')).toBeLessThan(block.indexOf('isRendererEvalAvailable('));
    expect(block.indexOf('rendererEvalSessionRefusal(')).toBeLessThan(block.indexOf('args?.expression'));
    expect(block).toMatch(/isError: true/);
  });

  it('both transports hand the connection\'s aiSessionId to the server', () => {
    const calls = source.match(/createExtensionDevMcpServer\(\s*workspacePath,\s*typeof parsedUrl\.query\.aiSessionId === "string"/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it('other tools of the server are not touched by the guard', () => {
    expect(source.match(/rendererEvalSessionRefusal\(/g)).toHaveLength(1);
  });
});
