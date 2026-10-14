/**
 * State of the Tool Manifest card (Phase 1C of the ECC Architect).
 *
 * The card is driven by the host's stored-manifest notice (promptOrigin
 * `tool_manifest`, Phase 1B): it exists only because Nimbalyst persisted a
 * valid manifest, so a TOO LONG or INVALID manifest never gets one. Everything
 * the card shows comes from the Tracker item, read through the host; the card
 * writes nothing (the domain rules keep a manifest host-owned).
 */

import { useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { normalizeRelationshipValue } from '@nimbalyst/tracker-core';
import { interactiveWidgetHostAtom } from '../../../../store/atoms/interactiveWidgetHost';
import type { ToolManifestCardData, TrackerItemLike, TrackerItemsChange } from './InteractiveWidgetHost';

export const TOOL_MANIFEST_TRACKER_TYPE = 'tool-manifest';

/**
 * The notice names its manifest first, in every UI language:
 * "[Tool Manifest] M-2 ..." (see ai:toolManifest.notice).
 */
const NOTICE_MANIFEST_ID = /^\s*\[Tool Manifest\]\s+(M-[1-9]\d*)(?![\w-])/;

/** The manifest id a stored-manifest notice names, or null for any other text. */
export function parseToolManifestNoticeId(text: string | null | undefined): string | null {
  const match = NOTICE_MANIFEST_ID.exec(text ?? '');
  return match ? match[1] : null;
}

function fieldOf(item: TrackerItemLike, name: string): unknown {
  const custom = item.customFields;
  if (custom && typeof custom === 'object' && name in custom) return (custom as Record<string, unknown>)[name];
  return (item as Record<string, unknown>)[name];
}

function stringFieldOf(item: TrackerItemLike, name: string): string | null {
  const value = fieldOf(item, name);
  return typeof value === 'string' && value !== '' ? value : null;
}

export function isToolManifestItem(item: TrackerItemLike | null | undefined): boolean {
  if (!item || typeof item !== 'object') return false;
  return item.type === TOOL_MANIFEST_TRACKER_TYPE
    || (Array.isArray(item.typeTags) && item.typeTags.includes(TOOL_MANIFEST_TRACKER_TYPE));
}

/**
 * The stored manifest a notice names: the tool-manifest item of this team root
 * with this manifest id. Superseded ids are mapped to their M-<n> through the
 * same list; an unknown id is left out rather than shown as an internal id.
 */
export function pickToolManifestCardData(
  items: ReadonlyArray<TrackerItemLike>,
  rootSessionId: string,
  manifestId: string,
  sessionTitle: (sessionId: string) => string | null = () => null,
): ToolManifestCardData | null {
  const manifests = items.filter(isToolManifestItem);
  const match = manifests.find(
    (item) => stringFieldOf(item, 'teamRootSessionId') === rootSessionId && stringFieldOf(item, 'manifestId') === manifestId,
  );
  if (!match) return null;

  // The link's target ids whatever shape stores them: the host writes ids, the
  // tracker canonicalizes them to `{ itemId }` objects on its next write (NIB.29).
  const supersededItemIds = normalizeRelationshipValue(fieldOf(match, 'supersedes')).map((entry) => entry.itemId);
  const supersedes = supersededItemIds
    .map((itemId) => manifests.find((item) => item.id === itemId))
    .map((item) => (item ? stringFieldOf(item, 'manifestId') : null))
    .filter((id): id is string => id !== null);

  const confidence = stringFieldOf(match, 'confidence');
  const architectSessionId = stringFieldOf(match, 'architectSessionId');
  return {
    itemId: match.id,
    manifestId,
    status: typeof match.status === 'string' && match.status !== '' ? match.status : 'draft',
    confidence: confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : null,
    architectSessionId,
    architectTitle: architectSessionId ? sessionTitle(architectSessionId) : null,
    supersedes,
  };
}

/**
 * Whether a Tracker change can affect a manifest card: a tool-manifest was
 * added or updated, or an item was removed. A change without detail counts.
 */
export function trackerChangeTouchesManifests(change: TrackerItemsChange | undefined): boolean {
  if (!change || typeof change !== 'object') return true;
  if (Array.isArray(change.removed) && change.removed.length > 0) return true;
  return [...(change.added ?? []), ...(change.updated ?? [])].some(isToolManifestItem);
}

/** `error`: the host could not answer (an IPC failure); the plain notice is shown, never "not found". */
export type ToolManifestCardState = 'unsupported' | 'loading' | 'ready' | 'missing' | 'error';

export interface ToolManifestCardResolution {
  state: ToolManifestCardState;
  data: ToolManifestCardData | null;
}

/**
 * Resolves the manifest a notice names through the session's host and follows
 * Tracker changes (the coordinator accepting it, a newer manifest superseding
 * it). `unsupported` when the host cannot read the Tracker, `error` when it
 * failed to: the caller then shows the plain notice. Answers that arrive out of
 * order are dropped, so a stale read never overwrites a newer state.
 */
export function useToolManifestCard(sessionId: string, manifestId: string | null): ToolManifestCardResolution {
  const host = useAtomValue(interactiveWidgetHostAtom(sessionId));
  const resolve = host?.resolveToolManifest;
  const subscribe = host?.onTrackerItemsChanged;
  const supported = Boolean(resolve && manifestId);
  const [resolution, setResolution] = useState<ToolManifestCardResolution>({
    state: supported ? 'loading' : 'unsupported',
    data: null,
  });

  useEffect(() => {
    if (!resolve || !manifestId) {
      setResolution({ state: 'unsupported', data: null });
      return;
    }
    let cancelled = false;
    let latest = 0;
    setResolution({ state: 'loading', data: null });
    const load = () => {
      const request = ++latest;
      resolve(sessionId, manifestId).then(
        (data) => { if (!cancelled && request === latest) setResolution({ state: data ? 'ready' : 'missing', data }); },
        () => { if (!cancelled && request === latest) setResolution({ state: 'error', data: null }); },
      );
    };
    load();
    const unsubscribe = subscribe?.((change) => {
      if (trackerChangeTouchesManifests(change)) load();
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [resolve, subscribe, sessionId, manifestId]);

  return resolution;
}
