// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { guardToolManifestCreate, guardToolManifestUpdate, isToolManifestCreate } from '../toolManifestToolGuard';

const sessions: Record<string, unknown> = {
  root: { agentRole: 'standard', metadata: { teamMode: true } },
  'other-root': { agentRole: 'standard', metadata: { teamMode: true } },
  standalone: { agentRole: 'standard', metadata: {} },
  architect: { agentRole: 'standard', metadata: { teamChild: { role: 'architect', rootSessionId: 'root', depth: 1 } } },
  implementer: { agentRole: 'standard', metadata: { teamChild: { role: 'implementer', rootSessionId: 'root', depth: 1 } } },
  reviewer: { agentRole: 'standard', metadata: { teamChild: { role: 'reviewer', rootSessionId: 'root', depth: 1 } } },
};

beforeEach(() => {
  AISessionsRepository.setStore({ get: async (id: string) => sessions[id] ?? null } as never);
});
afterEach(() => {
  AISessionsRepository.clearStore();
});

const manifest = (status = 'draft') => ({
  id: 'tool-manifest_1',
  type: 'tool-manifest',
  status,
  customFields: { manifestId: 'M-1', teamRootSessionId: 'root', architectSessionId: 'architect', generatedByRole: 'architect' },
});
const text = (error: { content: Array<{ text: string }> } | null) => error?.content[0]?.text ?? '';

describe('tracker_create of a tool-manifest', () => {
  it('is refused for everyone: the host writes manifests from the architect session', () => {
    expect(isToolManifestCreate({ type: 'task' })).toBe(false);
    expect(isToolManifestCreate({ type: 'tool-manifest' })).toBe(true);
    expect(isToolManifestCreate({ type: 'task', typeTags: ['task', 'tool-manifest'] })).toBe(true);
    expect(isToolManifestCreate({ type: 'task', primaryType: 'tool-manifest' })).toBe(true);
    const refusal = guardToolManifestCreate();
    expect(refusal.isError).toBe(true);
    expect(text(refusal)).toMatch(/written by Nimbalyst when an architect session completes/);
    expect(text(refusal)).toMatch(/cannot be created by hand or through tracker_create/);
  });
});

describe('tracker_update of a tool-manifest', () => {
  it('other items pass untouched, but cannot become a manifest', async () => {
    expect(await guardToolManifestUpdate({ id: 'x', status: 'done' }, { type: 'task' }, 'root')).toBeNull();
    expect(text(await guardToolManifestUpdate({ id: 'x', primaryType: 'tool-manifest' }, { type: 'task' }, 'root'))).toMatch(/cannot be turned into a tool-manifest/);
    expect(text(await guardToolManifestUpdate({ id: 'x', typeTags: ['task', 'tool-manifest'] }, { type: 'task' }, 'root'))).toMatch(/cannot be turned into a tool-manifest/);
  });

  it('the coordinator of the manifest\'s team accepts it, with status at the top level or in fields', async () => {
    expect(await guardToolManifestUpdate({ id: 'tool-manifest_1', status: 'accepted' }, manifest(), 'root')).toBeNull();
    expect(await guardToolManifestUpdate({ id: 'tool-manifest_1', fields: { status: 'accepted' } }, manifest(), 'root')).toBeNull();
    expect(await guardToolManifestUpdate({ id: 'tool-manifest_1', status: 'accepted', fields: { status: 'accepted' } }, manifest(), 'root')).toBeNull();
    expect(await guardToolManifestUpdate({ id: 'tool-manifest_1', status: 'accepted', typeTags: ['tool-manifest'], primaryType: 'tool-manifest' }, manifest(), 'root')).toBeNull();
    // Accepting again is a harmless no-op, not an error.
    expect(await guardToolManifestUpdate({ id: 'tool-manifest_1', status: 'accepted' }, manifest('accepted'), 'root')).toBeNull();
  });

  it('members never write: the architect, an implementer and a reviewer are refused', async () => {
    for (const member of ['architect', 'implementer', 'reviewer']) {
      const refusal = await guardToolManifestUpdate({ id: 'tool-manifest_1', status: 'accepted' }, manifest(), member);
      expect(text(refusal), member).toMatch(/Team members cannot change a Tool Manifest/);
    }
  });

  it('another team\'s coordinator, a standalone session, an unknown caller and no caller are refused', async () => {
    for (const caller of ['other-root', 'standalone', 'ghost', undefined]) {
      const refusal = await guardToolManifestUpdate({ id: 'tool-manifest_1', status: 'accepted' }, manifest(), caller);
      expect(text(refusal), String(caller)).toMatch(/Only the coordinator of the team that received this manifest can accept it/);
    }
  });

  it('a session that cannot be read is refused, never guessed', async () => {
    AISessionsRepository.setStore({ get: async () => { throw new Error('db down'); } } as never);
    const refusal = await guardToolManifestUpdate({ id: 'tool-manifest_1', status: 'accepted' }, manifest(), 'root');
    expect(text(refusal)).toMatch(/Could not verify the calling session/);
  });

  it('nothing but accepting: forged provenance, a new body, a new title, another status, archiving', async () => {
    const attempts: Array<Record<string, unknown>> = [
      { id: 'tool-manifest_1', status: 'accepted', fields: { architectSessionId: 'root' } },
      { id: 'tool-manifest_1', status: 'accepted', fields: { teamRootSessionId: 'other-root' } },
      { id: 'tool-manifest_1', status: 'accepted', fields: { manifestId: 'M-9' } },
      { id: 'tool-manifest_1', status: 'accepted', fields: { generatedByRole: 'coordinator' } },
      { id: 'tool-manifest_1', status: 'accepted', fields: { supersedes: ['x'] } },
      { id: 'tool-manifest_1', description: 'rewritten' },
      { id: 'tool-manifest_1', status: 'accepted', description: 'rewritten' },
      { id: 'tool-manifest_1', title: 'renamed' },
      { id: 'tool-manifest_1', status: 'superseded' },
      { id: 'tool-manifest_1', status: 'draft' },
      { id: 'tool-manifest_1', status: 'done' },
      { id: 'tool-manifest_1', archived: true },
      { id: 'tool-manifest_1', published: true },
      { id: 'tool-manifest_1' },
      { id: 'tool-manifest_1', fields: 'accepted' },
      // The fields bag is merged after the top-level status by the write: a mismatch is never half-accepted.
      { id: 'tool-manifest_1', status: 'accepted', fields: { status: 'draft' } },
      { id: 'tool-manifest_1', status: 'accepted', fields: { status: 'superseded' } },
      { id: 'tool-manifest_1', status: 'draft', fields: { status: 'accepted' } },
    ];
    for (const args of attempts) {
      const refusal = await guardToolManifestUpdate(args, manifest(), 'root');
      expect(text(refusal), JSON.stringify(args)).toMatch(/only ever accepted|cannot change type/);
    }
    expect(text(await guardToolManifestUpdate({ id: 'tool-manifest_1', status: 'accepted', primaryType: 'task' }, manifest(), 'root'))).toMatch(/cannot change type/);
  });

  it('a superseded manifest is not accepted: the current one is the newest', async () => {
    const refusal = await guardToolManifestUpdate({ id: 'tool-manifest_1', status: 'accepted' }, manifest('superseded'), 'root');
    expect(text(refusal)).toMatch(/superseded; the current manifest is the newest one/);
  });
});
