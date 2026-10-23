/**
 * BrowserAuthority
 *
 * The one main-process module that decides WHO is calling the embedded browser
 * and WHICH partition a session lives in. The `browser-session:*` IPC handlers
 * use it today; the future `portal.*` tools (F1.2) use the same functions, so
 * there is a single place to audit and no second browser engine.
 *
 * Who is calling
 *   - The user's own UI sends no actor and keeps full control.
 *   - An agent is a caller holding an *actor token*. Main mints the token for
 *     one tool call, from the MCP connection's session id
 *     (extensionToolHandler), and the renderer only carries it back in the
 *     `actorSessionId` field. The renderer cannot invent an identity: a bare
 *     session id, a guessed or revoked token, or any other value is refused --
 *     never read as the user.
 *   - A call with no MCP session id has no token and is rejected upstream; there
 *     is no placeholder actor.
 *
 * Which partition
 *   - User sessions keep today's rule (`resolveBrowserPartitionName`).
 *   - Every agent portal gets a fresh in-memory partition chosen here. An agent
 *     can never name a partition (neither `browser-preview` nor a persisted
 *     one), and nothing but the portal ever lives in it.
 *   - Agent partitions are locked down: every permission (microphone and
 *     null-webContents checks included), every device, and every download is
 *     denied.
 *
 * (No logger import on purpose: this module is imported by light-weight callers.)
 *
 * Known limit: an omitted `actorSessionId` is the user's UI. The renderer is
 * the trusted hop, so a renderer that drops the field is indistinguishable from
 * the user; `withActorToken` reports when a token was never presented so the
 * caller can flag it. Closing it fully means executing agent calls in main
 * (`portal.*`, F1.2).
 */

import { randomBytes, randomUUID } from 'crypto';
import type { Session } from 'electron';

/** Fixed actor for tools run through `extension_test_ai_tool`. Owns only its own sessions. */
export const EXTENSION_DEV_TEST_ACTOR = 'extension-dev-test';

/** Fixed actor for the mobile voice tool path, which has no MCP connection. */
export const MOBILE_VOICE_ACTOR = 'mobile-voice';

/** Longer than the 30s tool timeout, so a token outlives the call it was minted for but not much more. */
const ACTOR_TOKEN_TTL_MS = 2 * 60 * 1000;

const TOKEN_PREFIX = 'nimactor_';
const AGENT_PARTITION_PREFIX = 'agent-portal-';

interface TokenEntry {
  actorId: string;
  expiresAt: number;
  used: boolean;
}

const tokens = new Map<string, TokenEntry>();

/** Tests only. */
export function __resetActorTokensForTests(): void {
  tokens.clear();
}

function sweepExpired(now: number): void {
  for (const [token, entry] of tokens) {
    if (entry.expiresAt <= now) tokens.delete(token);
  }
}

/** Mint an opaque token that stands for `actorId` until revoked or expired. */
export function issueActorToken(actorId: string, ttlMs: number = ACTOR_TOKEN_TTL_MS): string {
  const now = Date.now();
  sweepExpired(now);
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString('hex')}`;
  tokens.set(token, { actorId, expiresAt: now + ttlMs, used: false });
  return token;
}

/** Invalidate a token; returns whether it had been presented at least once. */
export function revokeActorToken(token: string): { used: boolean } {
  const entry = tokens.get(token);
  tokens.delete(token);
  return { used: entry?.used === true };
}

/**
 * Run `work` with a fresh token for `actorId`, revoking it afterwards (also when
 * `work` throws). `used` tells whether anything presented the token.
 */
export async function withActorToken<T>(
  actorId: string,
  work: (token: string) => Promise<T>,
): Promise<{ value: T; used: boolean }> {
  const token = issueActorToken(actorId);
  try {
    const value = await work(token);
    return { value, used: tokens.get(token)?.used === true };
  } finally {
    tokens.delete(token);
  }
}

export type CallerResolution = { ok: true; actor: string | undefined } | { ok: false; error: string };

/**
 * Resolve the `actorSessionId` field of a browser IPC payload. Absent or null is
 * the user's UI (`actor` undefined). A valid token is the agent it was issued
 * for. Everything else is refused.
 */
export function resolveCaller(raw: unknown): CallerResolution {
  if (raw === undefined || raw === null) return { ok: true, actor: undefined };
  if (typeof raw !== 'string' || !raw.startsWith(TOKEN_PREFIX)) {
    return { ok: false, error: 'Unattributed or invalid browser actor' };
  }
  const entry = tokens.get(raw);
  if (!entry || entry.expiresAt <= Date.now()) {
    tokens.delete(raw);
    return { ok: false, error: 'Unattributed or invalid browser actor' };
  }
  entry.used = true;
  return { ok: true, actor: entry.actorId };
}

// ---------- partitions ----------

/** Same rule the user's sessions have always had. */
function userPartitionName(partition?: string): string {
  const normalized = partition?.trim() || 'preview';
  return normalized.startsWith('persist:') ? normalized : `browser-${normalized}`;
}

export function isAgentPartitionName(name: string): boolean {
  return name.startsWith(AGENT_PARTITION_PREFIX);
}

/**
 * Partition for a new session. `ownerSessionId` null is a user session. An agent
 * gets a fresh in-memory partition and may not ask for one.
 */
export function selectPartition(ownerSessionId: string | null, requested?: string): string {
  if (ownerSessionId === null) return userPartitionName(requested);
  if (requested !== undefined && requested !== null && String(requested).trim() !== '') {
    throw new Error('Agents cannot choose a browser partition');
  }
  return `${AGENT_PARTITION_PREFIX}${randomUUID()}`;
}

/** Most portals one agent may hold open at once (M-9 R7). */
export const MAX_PORTALS_PER_AGENT = 2;

/** Throws when the agent already holds the maximum number of open portals. */
export function assertPortalCapacity(openPortals: number): void {
  if (openPortals >= MAX_PORTALS_PER_AGENT) {
    throw new Error(
      `An agent may keep at most ${MAX_PORTALS_PER_AGENT} open browser portals; close one before opening another`,
    );
  }
}

/**
 * Agent partitions currently held. Electron offers no public way to destroy a
 * `Session` object, so the object itself outlives the portal. This registry is
 * what shows (and tests) that main has let go of the portal: data wiped, entry
 * dropped. The lockdown itself is never taken off (see `releaseAgentPartition`).
 */
const agentPartitions = new Map<string, Session>();

export function agentPartitionCount(): number {
  return agentPartitions.size;
}

/** Tests only. */
export function __resetAgentPartitionsForTests(): void {
  agentPartitions.clear();
}

/**
 * Deny everything on an agent partition: all permission requests and checks
 * (audio included, `webContents` null or not), device access, and downloads.
 * Safe to apply here because nothing but agent portals uses these partitions.
 * The entry is registered first, so a failure part-way through the install
 * still leaves a partition that `releaseAgentPartition` knows about and wipes.
 * The handlers stay for the life of the `Session` object.
 */
export function lockDownAgentPartition(ses: Session, label: string): void {
  agentPartitions.set(label, ses);
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler?.(() => false);
  ses.on('will-download', ((event: { preventDefault: () => void }) => {
    event.preventDefault();
    console.warn(`[BrowserAuthority] Blocked download in agent partition ${label}`);
  }) as never);
}

/**
 * End of an agent portal, on every path (close, reaper, host window, failed
 * create): wipe what it stored and drop it from the registry. Idempotent.
 *
 * The deny-all handlers and the download-cancel listener are deliberately left
 * installed. Electron cannot destroy the `Session`, and with the handlers gone
 * it would fall back to allow and save, leaving a window where the partition is
 * not locked down.
 */
export function releaseAgentPartition(label: string): void {
  const ses = agentPartitions.get(label);
  if (!ses) return;
  agentPartitions.delete(label);
  void Promise.resolve(ses.clearStorageData?.())
    .then(() => ses.clearCache?.())
    .catch((err: unknown) => {
      console.warn(
        `[BrowserAuthority] Could not wipe agent partition ${label}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}
