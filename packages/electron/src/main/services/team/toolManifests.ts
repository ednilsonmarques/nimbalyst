/**
 * Tool Manifests persisted as `tool-manifest` tracker items (Phase 1B of the
 * ECC Architect; runtime TrackerPlugin builtins/tool-manifest.yaml).
 *
 * Content from the flow, provenance from the system: the body is the
 * architect's final message exactly as it reached the coordinator in the
 * [Child Session Update]; the manifest id, the team, the architect session,
 * the model and the confidence are read by the host from the sessions and the
 * parsed manifest, never from an agent (teamNotes.ts follows the same rule).
 * The coordinator reads the item with tracker_get and may accept it (status
 * only, see mcp/tools/toolManifestToolGuard.ts); nobody edits it; a follow-up
 * produces the next version and the earlier ones become `superseded`, so one
 * manifest is current at a time: the newest non-superseded item.
 *
 * Only valid manifests are stored (never a TOO LONG or an INVALID report).
 * Idempotent: a replayed settle (same architect, same declared id, same body)
 * is recognized and nothing is written twice. Ids are monotonic per team: a
 * declared id already used, or not above the newest, gets the next number and
 * keeps the declared one in `declaredManifestId`.
 */

import { createHash } from 'crypto';
import { t } from '@nimbalyst/runtime/i18n';
import {
  TOOL_MANIFEST_PROMPT_ORIGIN,
  TOOL_MANIFEST_REF_METADATA_KEY,
} from '@nimbalyst/runtime/ai/server/providers/teamContext';
import {
  TOOL_MANIFEST_ID,
  assessArchitectReport,
  parseToolManifest,
} from '@nimbalyst/runtime/ai/server/providers/toolManifest';
import {
  TOOL_MANIFEST_TYPE,
  type ToolManifestStatus,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/models/toolManifestRules';
import { database as databaseWorker } from '../../database/PGLiteDatabaseWorker';

export { TOOL_MANIFEST_TYPE };

/** How the notice is queued: system provenance, shown as a status line (like the Team checkpoint notice). */
export const TOOL_MANIFEST_NOTICE_CONTEXT = Object.freeze({
  promptOrigin: TOOL_MANIFEST_PROMPT_ORIGIN,
  promptProvenance: Object.freeze({ actor: 'system', origin: 'session-orchestration', messageKind: 'status' } as const),
});

const TITLE_TASK_MAX_CHARS = 100;

/** What the host keeps of an existing manifest item of a team. */
export interface StoredToolManifest {
  itemId: string;
  ref: string;
  manifestId: string | null;
  status: string | null;
  architectSessionId: string | null;
  declaredManifestId: string | null;
  contentHash: string | null;
  /** Archived items still count for numbering and replay; they are never the current manifest. */
  archived: boolean;
}

export interface ToolManifestCreatePayload {
  title: string;
  description: string;
  status: 'draft';
  customFields: Record<string, unknown>;
}

/** The tracker, as this module needs it (toolManifestTrackerPort.ts binds it to the document service). */
export interface ToolManifestTrackerPort {
  listTeamManifests(rootSessionId: string): Promise<StoredToolManifest[]>;
  create(payload: ToolManifestCreatePayload): Promise<{ itemId: string; ref: string }>;
  setStatus(itemId: string, status: ToolManifestStatus): Promise<void>;
}

export interface ArchitectSettle {
  sessionId: string;
  rootSessionId: string;
  workspacePath: string;
  model: string | null;
  /** The architect's final message, whole (the [Child Session Update] carries the same text). */
  finalOutput: string | null;
}

/** An earlier manifest of the team that the new one replaces. */
export interface SupersededToolManifest {
  itemId: string;
  manifestId: string | null;
  ref: string;
}

export type ToolManifestPersistencePlan =
  | { action: 'skip'; reason: 'already-persisted'; itemId: string }
  | {
      action: 'create';
      manifestId: string;
      declaredManifestId: string | null;
      supersedesItemId: string | null;
      superseded: SupersededToolManifest[];
    };

/** Short pointer kept on the team root (`metadata.toolManifestRef`); never the manifest itself. */
export interface ToolManifestRef {
  itemId: string;
  ref: string;
  manifestId: string;
  architectSessionId: string;
  at: string;
}

export type ToolManifestPersistence =
  | {
      persisted: false;
      reason: 'no-output' | 'not-a-manifest' | 'invalid' | 'too-long' | 'already-persisted' | 'failed';
      detail?: string;
    }
  | {
      persisted: true;
      itemId: string;
      ref: string;
      manifestId: string;
      declaredManifestId: string | null;
      confidence: string | null;
      architectSessionId: string;
      rootSessionId: string;
      supersedesItemId: string | null;
      superseded: SupersededToolManifest[];
      /** Items that should have been marked superseded but could not be (logged and named in the notice; the next version retries them). */
      supersedeFailures: SupersededToolManifest[];
    };

export function manifestNumber(id: string | null | undefined): number {
  return typeof id === 'string' && TOOL_MANIFEST_ID.test(id) ? Number(id.slice(2)) : 0;
}

/** Fingerprint of a body: a replayed completion is recognized, never stored twice. */
export function toolManifestContentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * The deterministic rule. Pure.
 * - Replay (same architect, same declared id, same body): nothing to do.
 * - Number: the declared one when it is above the team's newest, else newest + 1
 *   (the declared id is then kept in `declaredManifestId`).
 * - The new manifest supersedes every non-superseded one of the team and
 *   links to the newest of them: one current manifest at a time.
 */
export function planToolManifestPersistence(
  declared: { id: string; contentHash: string },
  existing: readonly StoredToolManifest[],
  architectSessionId: string,
): ToolManifestPersistencePlan {
  const replay = existing.find((item) =>
    item.architectSessionId === architectSessionId
    && (item.manifestId === declared.id || item.declaredManifestId === declared.id)
    && item.contentHash === declared.contentHash);
  if (replay) return { action: 'skip', reason: 'already-persisted', itemId: replay.itemId };

  const newest = Math.max(0, ...existing.map((item) => manifestNumber(item.manifestId)));
  const wanted = manifestNumber(declared.id);
  const assigned = wanted > newest ? wanted : newest + 1;
  const manifestId = `M-${assigned}`;
  const current = existing
    .filter((item) => item.status !== 'superseded' && !item.archived)
    .sort((a, b) => manifestNumber(b.manifestId) - manifestNumber(a.manifestId));
  return {
    action: 'create',
    manifestId,
    declaredManifestId: manifestId === declared.id ? null : declared.id,
    supersedesItemId: current[0]?.itemId ?? null,
    superseded: current.map((item) => ({ itemId: item.itemId, manifestId: item.manifestId, ref: item.ref })),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Same merge as authorizeTeamContinuation (metaAgentSessionQueries): the key is
 * creation-only for ordinary metadata writes (teamSessionMetadata.ts), so this
 * statement is its only writer and no session can point its team elsewhere.
 */
export async function recordToolManifestRef(rootSessionId: string, ref: ToolManifestRef): Promise<void> {
  await databaseWorker.query(
    `UPDATE ai_sessions SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb WHERE id = $2`,
    [JSON.stringify({ [TOOL_MANIFEST_REF_METADATA_KEY]: ref }), rootSessionId],
  );
}

export interface PersistArchitectManifestDeps {
  recordRootRef?: (rootSessionId: string, ref: ToolManifestRef) => Promise<void>;
  log?: (message: string, detail?: unknown) => void;
  now?: () => Date;
}

/**
 * Store a completed architect's manifest when, and only when, it is valid.
 * Never throws: a failure is the result's reason (and the [Child Session
 * Update], which carries the manifest whole, goes out regardless).
 */
export async function persistArchitectManifest(
  settle: ArchitectSettle,
  port: ToolManifestTrackerPort,
  deps: PersistArchitectManifestDeps = {},
): Promise<ToolManifestPersistence> {
  const log = deps.log ?? ((message: string, detail?: unknown) => console.warn(`[tool-manifest] ${message}`, detail ?? ''));
  const text = settle.finalOutput;
  if (!text) return { persisted: false, reason: 'no-output' };
  const assessment = assessArchitectReport(text);
  if (assessment.kind === 'none') return { persisted: false, reason: 'not-a-manifest' };
  if (assessment.kind === 'too-long') {
    return { persisted: false, reason: 'too-long', detail: `${assessment.chars} characters, limit ${assessment.limit}` };
  }
  if (assessment.kind === 'invalid') return { persisted: false, reason: 'invalid', detail: assessment.errors.join('; ') };

  try {
    const validation = parseToolManifest(text);
    const manifest = validation.manifest;
    if (!validation.ok || !manifest || typeof manifest.id !== 'string' || !TOOL_MANIFEST_ID.test(manifest.id)) {
      return { persisted: false, reason: 'invalid', detail: validation.errors.join('; ') || 'no manifest id' };
    }
    const contentHash = toolManifestContentHash(text);
    const existing = await port.listTeamManifests(settle.rootSessionId);
    const plan = planToolManifestPersistence({ id: manifest.id, contentHash }, existing, settle.sessionId);
    if (plan.action === 'skip') return { persisted: false, reason: 'already-persisted', detail: plan.itemId };

    const confidence = typeof manifest.confidence === 'string' ? manifest.confidence : null;
    const task = typeof manifest.task === 'string' ? manifest.task.replace(/\s+/g, ' ').trim() : '';
    const title = `${plan.manifestId}: ${task ? truncate(task, TITLE_TASK_MAX_CHARS) : 'Tool Manifest'}`;
    const customFields: Record<string, unknown> = {
      manifestId: plan.manifestId,
      manifestVersion: '1',
      teamRootSessionId: settle.rootSessionId,
      architectSessionId: settle.sessionId,
      generatedByRole: 'architect',
      contentHash,
    };
    if (settle.model) customFields.model = settle.model;
    if (confidence) customFields.confidence = confidence;
    if (plan.declaredManifestId) customFields.declaredManifestId = plan.declaredManifestId;
    if (plan.supersedesItemId) customFields.supersedes = [plan.supersedesItemId];

    const created = await port.create({ title, description: text, status: 'draft', customFields });

    const superseded: SupersededToolManifest[] = [];
    const supersedeFailures: SupersededToolManifest[] = [];
    for (const item of plan.superseded) {
      try {
        await port.setStatus(item.itemId, 'superseded');
        superseded.push(item);
      } catch (error) {
        supersedeFailures.push(item);
        log(`could not mark ${item.itemId} (${item.manifestId ?? 'M-?'}) superseded`, error);
      }
    }

    const ref: ToolManifestRef = {
      itemId: created.itemId,
      ref: created.ref,
      manifestId: plan.manifestId,
      architectSessionId: settle.sessionId,
      at: (deps.now ?? (() => new Date()))().toISOString(),
    };
    try {
      await (deps.recordRootRef ?? recordToolManifestRef)(settle.rootSessionId, ref);
    } catch (error) {
      log('could not record the manifest ref on the team root', error);
    }

    return {
      persisted: true,
      itemId: created.itemId,
      ref: created.ref,
      manifestId: plan.manifestId,
      declaredManifestId: plan.declaredManifestId,
      confidence,
      architectSessionId: settle.sessionId,
      rootSessionId: settle.rootSessionId,
      supersedesItemId: plan.supersedesItemId,
      superseded,
      supersedeFailures,
    };
  } catch (error) {
    log('persistence failed', error);
    return { persisted: false, reason: 'failed', detail: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * What the coordinator is told once a manifest is stored. Written in the UI
 * language (the user reads it as a system status line); short, and never the
 * manifest itself: the [Child Session Update] already carries that.
 */
export function buildToolManifestNotice(result: Extract<ToolManifestPersistence, { persisted: true }>): string {
  const parts = [
    t('ai:toolManifest.notice', {
      id: result.manifestId,
      ref: result.ref,
      architect: result.architectSessionId,
      confidence: result.confidence ?? 'unknown',
    }),
  ];
  if (result.declaredManifestId) {
    parts.push(t('ai:toolManifest.noticeRenumbered', { declared: result.declaredManifestId, id: result.manifestId }));
  }
  if (result.superseded.length > 0) {
    const names = result.superseded.map((item) => `${item.manifestId ?? 'M-?'} (${item.ref})`).join(', ');
    parts.push(t('ai:toolManifest.noticeSuperseded', { superseded: names, id: result.manifestId }));
  }
  if (result.supersedeFailures.length > 0) {
    const names = result.supersedeFailures.map((item) => `${item.manifestId ?? 'M-?'} (${item.ref})`).join(', ');
    parts.push(t('ai:toolManifest.noticeSupersedeFailed', { failed: names, id: result.manifestId }));
  }
  return parts.join(' ');
}

/** Compact one-line summary of a stored manifest for the coordinator's tracker_list. */
export function formatToolManifestSummary(item: {
  title?: string;
  status?: string;
  customFields?: Record<string, unknown>;
}, ref: string): string {
  const fields = item.customFields ?? {};
  const id = typeof fields.manifestId === 'string' ? fields.manifestId : 'M-?';
  const architect = typeof fields.architectSessionId === 'string' ? fields.architectSessionId.slice(0, 8) : null;
  const confidence = typeof fields.confidence === 'string' && fields.confidence ? fields.confidence : null;
  const origin = [architect ? `architect session ${architect}` : null, confidence ? `confidence ${confidence}` : null]
    .filter(Boolean)
    .join(', ');
  return `- [MANIFEST ${id}] ${item.title ?? ''} (${item.status ?? 'no status'}) [ref: ${ref}]${origin ? ` · ${origin}` : ''}`;
}
