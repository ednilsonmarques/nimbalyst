/**
 * Test-only `test:query-db` IPC channel.
 *
 * Playwright E2E specs use it to inspect the database from the renderer. The
 * channel is reachable from any renderer code through the generic preload
 * `invoke`, so it is guarded twice:
 *
 * - It is registered only when the app runs unpackaged AND under the E2E
 *   harness (`PLAYWRIGHT=1`, set by `buildTestEnv` in `e2e/helpers.ts`).
 *   `NODE_ENV` is deliberately ignored: the main bundle reads it at run time,
 *   so a missing or inherited value must never enable the channel. A packaged
 *   build never registers it, whatever the environment says.
 * - Where it is registered, every statement runs through `queryReadOnly`,
 *   which the database engine enforces (a read-only transaction on PGLite,
 *   `PRAGMA query_only` on SQLite). It never calls `database.query`.
 *   `PRAGMA query_only` does not stop SQLite's `VACUUM INTO` (writes a copy of
 *   the database to any path) or `ATTACH`, so the channel also accepts only
 *   statements that start with SELECT or WITH and contain none of VACUUM,
 *   ATTACH, DETACH or PRAGMA. A false refusal (e.g. one of those words inside
 *   a string literal) is acceptable for a test helper.
 */
import { app } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';

export const TEST_QUERY_DB_CHANNEL = 'test:query-db';

export interface TestQueryDbEnvironment {
  isPackaged: boolean | undefined;
  env: Record<string, string | undefined>;
}

export interface ReadOnlyQueryable {
  queryReadOnly(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Fail-closed: anything other than an unpackaged app under the E2E harness is refused. */
export function isTestQueryDbAllowed({ isPackaged, env }: TestQueryDbEnvironment): boolean {
  return isPackaged === false && env.PLAYWRIGHT === '1';
}

const FORBIDDEN_KEYWORDS = /\b(vacuum|attach|detach|pragma)\b/i;

/** Accepts only a SELECT or WITH statement free of the keywords the engines do not block. */
export function isAllowedTestQuery(sql: string): boolean {
  const code = sql.replace(/\/\*[\s\S]*?(\*\/|$)/g, ' ').replace(/--[^\n]*/g, ' ').trim();
  return /^(select|with)\b/i.test(code) && !FORBIDDEN_KEYWORDS.test(code);
}

/** Registers the channel when allowed and reports whether it did. */
export function registerTestQueryDbHandler(
  database: ReadOnlyQueryable,
  environment: TestQueryDbEnvironment = { isPackaged: app?.isPackaged, env: process.env },
): boolean {
  if (!isTestQueryDbAllowed(environment)) {
    return false;
  }

  safeHandle(TEST_QUERY_DB_CHANNEL, async (_event, sql: unknown, params?: unknown) => {
    if (typeof sql !== 'string' || sql.length === 0) {
      return { error: `${TEST_QUERY_DB_CHANNEL}: sql must be a non-empty string` };
    }
    if (!isAllowedTestQuery(sql)) {
      return { error: `${TEST_QUERY_DB_CHANNEL}: only SELECT or WITH statements are accepted` };
    }
    try {
      return await database.queryReadOnly(sql, Array.isArray(params) ? params : undefined);
    } catch (error) {
      console.error('[testQueryDbHandler] Test query error:', error);
      return { error: String(error) };
    }
  });
  return true;
}
