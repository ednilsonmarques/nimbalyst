// @vitest-environment node
/**
 * The Tool Manifest card is driven by the host's stored-manifest notice and
 * filled from the Tracker item it names. These are the pure parts: which text
 * is a notice, which item is the manifest, which Tracker change matters.
 */
import { describe, expect, it } from 'vitest';
import {
  isToolManifestItem,
  parseToolManifestNoticeId,
  pickToolManifestCardData,
  trackerChangeTouchesManifests,
} from '../toolManifestCardState';

const EN_NOTICE = '[Tool Manifest] M-2 from the architect (session arch-1) is stored as tracker item NIM.14 (confidence: high). It is the manifest in the architect\'s report, not a new one: do not re-read it now. It supersedes M-1 (NIM.9), now marked superseded: M-2 is the current manifest.';
const PT_NOTICE = '[Tool Manifest] M-1 do architect (sessão arch-1) foi gravado como item NIM.9 do Tracker (confiança: média). É o manifesto do relatório do architect, não um novo: não o releia agora.';

/** The team's manifests as the Tracker lists them, plus a task that borrows their fields. */
const items = [
  { id: 'tmf-1', type: 'tool-manifest', status: 'superseded', title: 'M-1: task', customFields: { manifestId: 'M-1', teamRootSessionId: 'root', architectSessionId: 'arch-1', confidence: 'medium' } },
  { id: 'tmf-2', type: 'tool-manifest', status: 'draft', title: 'M-2: task', customFields: { manifestId: 'M-2', teamRootSessionId: 'root', architectSessionId: 'arch-1', confidence: 'high', supersedes: ['tmf-1'] } },
  { id: 'tmf-elsewhere', type: 'tool-manifest', status: 'accepted', title: 'M-1: other', customFields: { manifestId: 'M-1', teamRootSessionId: 'other-root', architectSessionId: 'arch-9', confidence: 'low' } },
  { id: 'task-1', type: 'task', status: 'to-do', title: 'M-2', customFields: { manifestId: 'M-2', teamRootSessionId: 'root', architectSessionId: 'arch-1', confidence: 'high' } },
];

describe('parseToolManifestNoticeId', () => {
  it('reads the manifest id the notice names first, in either UI language', () => {
    expect(parseToolManifestNoticeId(EN_NOTICE)).toBe('M-2');
    expect(parseToolManifestNoticeId(PT_NOTICE)).toBe('M-1');
    expect(parseToolManifestNoticeId('  [Tool Manifest] M-12.')).toBe('M-12');
  });

  it('is null for anything that is not a stored-manifest notice', () => {
    const notNotices = [
      '', undefined, null,
      'MANIFEST TOO LONG: 9,120 characters (limit 7,500); YAML kept whole, Markdown dropped.',
      'MANIFEST INVALID: id must match M-<n>; task is required.',
      '[Child Session Update]\nSession: "Arquiteto"\n```yaml\ntoolManifest: 1\nid: M-3\n```',
      '[Checkpoint da equipe] O usuário autorizou a continuação.',
      'Tool Manifest M-2 is stored.',
      '[Tool Manifest] M-0 is not an id',
      '[Tool Manifest] M-2b',
    ];
    for (const text of notNotices) expect(parseToolManifestNoticeId(text), String(text)).toBeNull();
  });
});

describe('pickToolManifestCardData', () => {
  it('picks the team root\'s manifest with that id, and maps what it supersedes to manifest ids', () => {
    const data = pickToolManifestCardData(items, 'root', 'M-2', (id) => (id === 'arch-1' ? 'Arquiteto' : null));
    expect(data).toEqual({
      itemId: 'tmf-2',
      manifestId: 'M-2',
      status: 'draft',
      confidence: 'high',
      architectSessionId: 'arch-1',
      architectTitle: 'Arquiteto',
      supersedes: ['M-1'],
    });
  });

  it('keeps teams apart: the same id in another team is another manifest', () => {
    expect(pickToolManifestCardData(items, 'root', 'M-1')?.itemId).toBe('tmf-1');
    expect(pickToolManifestCardData(items, 'other-root', 'M-1')?.itemId).toBe('tmf-elsewhere');
    expect(pickToolManifestCardData(items, 'root', 'M-3')).toBeNull();
    expect(pickToolManifestCardData(items, 'nobody', 'M-1')).toBeNull();
    expect(pickToolManifestCardData([], 'root', 'M-1')).toBeNull();
  });

  it('never takes another type for a manifest, whatever fields it carries', () => {
    expect(pickToolManifestCardData(items.filter((item) => item.type !== 'tool-manifest'), 'root', 'M-2')).toBeNull();
    expect(isToolManifestItem(items[3])).toBe(false);
    expect(isToolManifestItem({ id: 'x', type: 'task', typeTags: ['task', 'tool-manifest'] })).toBe(true);
    expect(isToolManifestItem(null)).toBe(false);
  });

  it('reads the synced shape too, where provenance sits at the top level', () => {
    const synced = [{ id: 'tmf-s', type: 'tool-manifest', status: 'accepted', manifestId: 'M-1', teamRootSessionId: 'root', architectSessionId: 'arch-1', confidence: 'low' }];
    expect(pickToolManifestCardData(synced, 'root', 'M-1')).toMatchObject({ itemId: 'tmf-s', status: 'accepted', confidence: 'low', architectTitle: null, supersedes: [] });
  });

  it('tolerates what it cannot interpret: unknown superseded ids, a single id, an odd confidence, no status', () => {
    const odd = [
      { id: 'tmf-a', type: 'tool-manifest', customFields: { manifestId: 'M-1', teamRootSessionId: 'root', confidence: 'certain', supersedes: 'tmf-gone' } },
      { id: 'tmf-b', type: 'tool-manifest', status: 'draft', customFields: { manifestId: 'M-2', teamRootSessionId: 'root', supersedes: 'tmf-a' } },
    ];
    expect(pickToolManifestCardData(odd, 'root', 'M-1')).toMatchObject({ status: 'draft', confidence: null, architectSessionId: null, supersedes: [] });
    expect(pickToolManifestCardData(odd, 'root', 'M-2')?.supersedes).toEqual(['M-1']);
  });
});

describe('trackerChangeTouchesManifests', () => {
  it('reloads for manifests and removals only', () => {
    expect(trackerChangeTouchesManifests(undefined)).toBe(true);
    expect(trackerChangeTouchesManifests({ updated: [items[1]] })).toBe(true);
    expect(trackerChangeTouchesManifests({ added: [items[0]] })).toBe(true);
    expect(trackerChangeTouchesManifests({ removed: ['tmf-1'] })).toBe(true);
    expect(trackerChangeTouchesManifests({ updated: [items[3]] })).toBe(false);
    expect(trackerChangeTouchesManifests({ added: [], updated: [], removed: [] })).toBe(false);
  });
});
