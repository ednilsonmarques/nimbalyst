/**
 * Binds toolManifests.ts to the workspace's tracker through the document
 * service, the same funnel the Tracker UI and the MCP tools use (local keys,
 * watchers, sync status, relationship index). The creation goes through
 * `createHostOwnedTrackerItem`, the only path that may carry host provenance;
 * it is not reachable over IPC or MCP.
 */

import type { TrackerItem } from '@nimbalyst/runtime/core/DocumentService';
import {
  TOOL_MANIFEST_TYPE,
  readToolManifestField,
  type ToolManifestStatus,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/toolManifestRules';
import { isLocalIssueKey, isLocalKeyReference } from '../../../shared/localIssueKey';
import type { NativeTrackerCreatePayload } from '../tracker/createNativeTrackerItem';
import type { StoredToolManifest, ToolManifestCreatePayload, ToolManifestTrackerPort } from './toolManifests';

export interface ManifestDocumentService {
  listTrackerItems(): Promise<TrackerItem[]>;
  createHostOwnedTrackerItem(payload: NativeTrackerCreatePayload): Promise<TrackerItem>;
  updateTrackerItem(itemId: string, updates: Record<string, unknown>): Promise<TrackerItem>;
  destroy?: () => void;
}

function stringField(item: TrackerItem, name: string): string | null {
  const value = readToolManifestField(item as unknown as Record<string, unknown>, name);
  return typeof value === 'string' && value ? value : null;
}

/**
 * The reference the host hands the coordinator for a manifest item: the one
 * tracker_get / tracker_update resolve for it. The published issue key when
 * the item has one (global), else the item id. Never the local number
 * (`WOK.1`): it resolves only together with the workspace that numbered it
 * and changes when the workspace prefix is reassigned, so it is a display
 * label, not a reference (pilot G, 2026-10-14). Fail-closed: an item with
 * neither has no reference, and none is invented.
 */
export function trackerItemReference(item: { id?: unknown; issueKey?: unknown }): string {
  const issueKey = typeof item.issueKey === 'string' ? item.issueKey.trim() : '';
  if (issueKey && !isLocalIssueKey(issueKey) && !isLocalKeyReference(issueKey)) return issueKey;
  const id = typeof item.id === 'string' ? item.id.trim() : '';
  if (id) return id;
  throw new Error('tracker item has neither an issue key nor an id to reference');
}

export function toStoredToolManifest(item: TrackerItem): StoredToolManifest {
  return {
    itemId: item.id,
    ref: trackerItemReference(item),
    manifestId: stringField(item, 'manifestId'),
    status: typeof item.status === 'string' ? item.status : null,
    architectSessionId: stringField(item, 'architectSessionId'),
    declaredManifestId: stringField(item, 'declaredManifestId'),
    contentHash: stringField(item, 'contentHash'),
    archived: item.archived === true,
  };
}

export function buildToolManifestTrackerPort(docService: ManifestDocumentService, workspacePath: string): ToolManifestTrackerPort {
  return {
    async listTeamManifests(rootSessionId: string): Promise<StoredToolManifest[]> {
      const items = await docService.listTrackerItems();
      // Archived manifests are listed too: they keep their number (a replay
      // or a reused id must not recreate them); the rule never supersedes them.
      return items
        .filter((item) => item.type === TOOL_MANIFEST_TYPE && stringField(item, 'teamRootSessionId') === rootSessionId)
        .map(toStoredToolManifest);
    },
    async create(payload: ToolManifestCreatePayload): Promise<{ itemId: string; ref: string }> {
      // Same id shape as the MCP create path.
      const id = `${TOOL_MANIFEST_TYPE}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const item = await docService.createHostOwnedTrackerItem({
        id,
        type: TOOL_MANIFEST_TYPE,
        title: payload.title,
        status: payload.status,
        priority: 'medium',
        workspace: workspacePath,
        description: payload.description,
        customFields: payload.customFields,
      });
      return { itemId: item.id, ref: trackerItemReference(item) };
    },
    async setStatus(itemId: string, status: ToolManifestStatus): Promise<void> {
      await docService.updateTrackerItem(itemId, { status });
    },
  };
}

/** Run `fn` with a port bound to the workspace's document service (the window's, or a temporary one). */
export async function withToolManifestTrackerPort<T>(
  workspacePath: string,
  fn: (port: ToolManifestTrackerPort) => Promise<T>,
): Promise<T> {
  const { documentServices } = await import('../../window/WindowManager');
  let docService = documentServices.get(workspacePath) as unknown as ManifestDocumentService | undefined;
  let temporary: ManifestDocumentService | null = null;
  if (!docService) {
    const { ElectronDocumentService } = await import('../ElectronDocumentService');
    docService = new ElectronDocumentService(workspacePath) as unknown as ManifestDocumentService;
    temporary = docService;
  }
  try {
    return await fn(buildToolManifestTrackerPort(docService, workspacePath));
  } finally {
    temporary?.destroy?.();
  }
}
