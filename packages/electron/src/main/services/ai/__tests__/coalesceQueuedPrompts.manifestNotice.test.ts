// @vitest-environment node
/**
 * NIB.25, the part that stays by contract: the Tool Manifest notice row is a
 * system status row (it renders the Tool Manifest card), and the queue folds
 * only agent-authored rows into one turn, keeping the HEAD row's provenance
 * for the merged prompt. So the notice cannot ride the update's turn without
 * losing the card: it keeps its own short turn (or is read in-turn through
 * the inbox), while the reference itself now travels inside the update
 * (buildToolManifestReference). This test pins both facts.
 */
import { describe, expect, it } from 'vitest';
import { mergeClaimedRun, selectCoalescibleRun, type CoalescibleQueuedPrompt } from '../coalesceQueuedPrompts';

const update = {
  id: 'u1', prompt: '[Child Session Update]\nSession: "Architect" (child-1)\nTool Manifest stored: M-1 as tracker item NIB.31 (status draft).',
  attachments: null,
  documentContext: { promptProvenance: { actor: 'agent', origin: 'child-session-update', messageKind: 'report', originSessionId: 'child-1' } },
} as unknown as CoalescibleQueuedPrompt & { documentContext: Record<string, unknown> & { promptProvenance: Record<string, unknown> } };
const notice = {
  id: 'n1', prompt: '[Tool Manifest] M-1 from the architect (session child-1) is stored as tracker item NIB.31 (confidence: high).',
  attachments: null,
  documentContext: { promptOrigin: 'tool_manifest', promptProvenance: { actor: 'system', origin: 'session-orchestration', messageKind: 'status' } },
} as unknown as CoalescibleQueuedPrompt & { documentContext: Record<string, unknown> & { promptProvenance: Record<string, unknown> } };

describe('the manifest notice row and the queue', () => {
  it('a system notice behind the update is a boundary: the update is delivered alone, the notice keeps its own row', () => {
    expect(selectCoalescibleRun([update, notice]).map((row) => row.id)).toEqual(['u1']);
    expect(selectCoalescibleRun([notice, update]).map((row) => row.id)).toEqual(['n1']);
  });

  it('a merged run keeps the head row\'s provenance, so folding the notice behind the update would drop the card origin', () => {
    const merged = mergeClaimedRun([update as never, { ...notice, documentContext: { ...notice.documentContext, promptProvenance: { ...notice.documentContext.promptProvenance, actor: 'agent' } } } as never]) as typeof update & { documentContext: Record<string, unknown> };
    expect(merged.documentContext).toEqual(update.documentContext);
    expect(merged.documentContext).not.toHaveProperty('promptOrigin');
    expect(merged.prompt).toContain('[Tool Manifest] M-1');
  });
});
