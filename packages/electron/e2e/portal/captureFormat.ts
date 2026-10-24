/**
 * F1.3a: pure formatting of what the Portal fixture observed (no Electron, no
 * Playwright, no I/O), so redaction and filtering are unit-tested
 * (captureFormat.test.ts).
 *
 * Input: raw events the main-process listeners recorded (capture.ts) and the
 * fixture servers' request logs. Output: redacted, classified records for
 * portal-console.jsonl / portal-network.jsonl and a summary.
 *
 * Redaction happens here, BEFORE anything is written: headers are never
 * copied; cookie and authorization values the servers saw, plus the known
 * secrets of the run, are removed from every URL and message; sensitive query
 * values, bearer tokens, key=value secrets, long opaque blobs and personal
 * paths are replaced.
 *
 * Classification ("class"): `failure` = an error a reader should look at
 * (console error, uncaught exception or rejection, a failed request, HTTP >= 400,
 * an unexpected request or origin, a renderer that died); `noise` = matched one
 * of FILTER_RULES (known Electron/fixture noise, kept and labelled, never
 * hidden); `event` = everything else. The only thing dropped is the host
 * window's own info/debug console output (counted in `dropped`). Nothing here
 * decides whether a test fails: the summary is report-only.
 */

export type Context = 'portal' | 'user-tab' | 'host' | 'harness' | 'other' | 'unknown';
export type RecordClass = 'event' | 'noise' | 'failure';

export interface RawConsoleEvent {
  type: 'console';
  ts: number;
  wcId: number;
  context: Context;
  partition?: string;
  pageUrl?: string;
  level: string;
  message: string;
  sourceUrl?: string;
  line?: number;
  frame?: 'main' | 'sub';
}

export interface RawNetEvent {
  type: 'net';
  ts: number;
  wcId: number;
  context: Context;
  partition?: string;
  pageUrl?: string;
  kind: 'navigation-start' | 'navigation-blocked' | 'redirect' | 'response' | 'load-failed' | 'renderer-gone' | 'preload-error';
  url?: string;
  status?: number;
  errorCode?: number;
  errorDescription?: string;
  frame?: 'main' | 'sub';
}

export type RawEvent = RawConsoleEvent | RawNetEvent;

/** A request a fixture server received. `headers` are read only to learn what to redact; they are never written. */
export interface RawServerRequest {
  server: string;
  ts: number;
  method: string;
  url: string;
  status?: number;
  known: boolean;
  aborted: boolean;
  headers?: Record<string, unknown>;
}

export interface ConsoleRecord {
  ts: string;
  seq: number;
  case: string;
  kind: 'console' | 'uncaught-exception' | 'unhandled-rejection' | 'resource-error';
  level: string;
  class: RecordClass;
  rule?: string;
  context: Context;
  page: string;
  partition?: string;
  frame?: 'main' | 'sub';
  pageUrl?: string;
  message: string;
  source?: string;
}

export interface NetworkRecord {
  ts: string;
  seq: number;
  case: string;
  source: string;
  kind: string;
  class: RecordClass;
  rule?: string;
  context: Context | 'fixture-server';
  page?: string;
  partition?: string;
  frame?: 'main' | 'sub';
  method?: string;
  url?: string;
  status?: number;
  error?: string;
}

export const FILTER_RULES: ReadonlyArray<{ id: string; effect: 'dropped' | 'noise' | 'failure'; rule: string }> = [
  { id: 'host-verbose', effect: 'dropped', rule: "info/debug console output of the app's own window (context host); its warnings and errors are kept" },
  { id: 'harness-window', effect: 'noise', rule: 'anything from a window the test itself opened (probePartitionStorage)' },
  {
    id: 'fixture-extensions-missing',
    effect: 'noise',
    rule: "host error '[ExtensionLoader] Failed to load <id>: Main module not found': the fixture builds only the Browser extension (README, Build)",
  },
  { id: 'favicon-404', effect: 'noise', rule: 'GET /favicon.ico answered 404 (Chromium asks for it on its own; the fixture serves none)' },
  { id: 'aborted-navigation', effect: 'noise', rule: 'a load that ended in ERR_ABORTED (-3): a navigation that was cancelled or superseded, not a network error' },
  { id: 'unexpected-request', effect: 'failure', rule: 'a fixture server received a path it does not serve' },
  { id: 'unexpected-origin', effect: 'failure', rule: 'a portal or user tab navigated (or tried to) to an http(s) origin other than the fixture servers' },
];

// ---------------------------------------------------------------------------
// redaction
// ---------------------------------------------------------------------------
export interface Sanitizer {
  url(u: string): string;
  text(s: string): string;
  withSecrets(more: string[]): Sanitizer;
}

const SENSITIVE_KEY = /token|secret|passw|^pass$|pwd|^pin$|otp|auth|session|^sid$|sid$|key$|^code$|^state$|sig|cookie|jwt|credential|bearer/i;
const MIN_SECRET_LENGTH = 4;
const MAX_TEXT = 500;
const MAX_URL = 300;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function pathPattern(p: string): RegExp | null {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (parts.length < 2) return null;
  return new RegExp(parts.map(escapeRe).join('[\\\\/]+'), 'gi');
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

export function makeSanitizer(opts: { secrets: string[]; home?: string; tmpDirs?: string[]; repoRoot?: string; user?: string }): Sanitizer {
  const secrets = Array.from(new Set(opts.secrets.filter((s) => typeof s === 'string' && s.length >= MIN_SECRET_LENGTH))).sort((a, b) => b.length - a.length);
  const secretRes = secrets.map((s) => new RegExp(escapeRe(s), 'g'));

  // Longest path first: the repo and temp dirs live under the home dir.
  const named: Array<[string, string]> = [
    ...(opts.tmpDirs ?? []).map((p) => [p, '<TEMP>'] as [string, string]),
    ...(opts.repoRoot ? [[opts.repoRoot, '<REPO>'] as [string, string]] : []),
    ...(opts.home ? [[opts.home, '<HOME>'] as [string, string]] : []),
  ].sort((a, b) => b[0].length - a[0].length);
  const pathRes = named.flatMap(([p, label]) => {
    const re = pathPattern(p);
    return re ? [[re, label] as [RegExp, string]] : [];
  });
  // The bare user name only as a whole token: a short or common name must not mangle ordinary words.
  const userRe = opts.user && opts.user.length >= 4 ? new RegExp(`(?<![A-Za-z0-9_-])${escapeRe(opts.user)}(?![A-Za-z0-9_-])`, 'gi') : null;

  const dropSecrets = (s: string) => secretRes.reduce((acc, re) => acc.replace(re, '[REDACTED]'), s);
  const dropPaths = (s: string) => {
    let out = pathRes.reduce((acc, [re, label]) => acc.replace(re, label), s);
    out = out.replace(/([A-Za-z]:[\\/]+Users[\\/]+)[^\\/\s"'<>:;,)]+/gi, '$1<user>');
    if (userRe) out = out.replace(userRe, '<user>');
    return out;
  };
  const dropBlobs = (s: string) => s.replace(/[A-Za-z0-9+_]{40,}={0,2}/g, '[REDACTED-BLOB]');

  const redactParams = (params: URLSearchParams) => {
    for (const key of Array.from(new Set(params.keys()))) if (SENSITIVE_KEY.test(key)) params.set(key, 'REDACTED');
  };
  /** Query and fragment parameters of any URL-like string (file:, other schemes, or an http URL `new URL` rejected). */
  const redactQuery = (s: string) => {
    const m = /^([^?#]*)(\?[^#]*)?(#.*)?$/s.exec(s);
    if (!m) return s;
    const part = (value: string | undefined, lead: string) => {
      if (!value || !value.includes('=')) return value ?? '';
      const params = new URLSearchParams(value.slice(1));
      redactParams(params);
      return `${lead}${params.toString()}`;
    };
    return `${m[1]}${part(m[2], '?')}${part(m[3], '#')}`;
  };

  const url = (u: string): string => {
    let s = dropSecrets(String(u ?? ''));
    if (/^data:/i.test(s)) return s.replace(/^(data:[^,;]*)[^,]*,.*$/is, '$1,[omitted]').slice(0, MAX_URL);
    if (/^(https?|wss?):/i.test(s)) {
      try {
        const parsed = new URL(s);
        parsed.username = '';
        parsed.password = '';
        redactParams(parsed.searchParams);
        if (parsed.hash.includes('=')) {
          const hashParams = new URLSearchParams(parsed.hash.slice(1));
          redactParams(hashParams);
          parsed.hash = hashParams.toString();
        }
        s = parsed.toString();
      } catch {
        s = redactQuery(s.replace(/^([a-z]+:\/\/)[^/@]*@/i, '$1'));
      }
    } else {
      s = redactQuery(s);
    }
    return truncate(dropBlobs(dropPaths(s)), MAX_URL);
  };

  const text = (input: string): string => {
    let s = dropSecrets(String(input ?? ''));
    s = s.replace(/\b(authorization|proxy-authorization|set-cookie|cookie|x-api-key|x-auth-token)\s*[:=]\s*[^\r\n]*/gi, '$1: [REDACTED]');
    s = s.replace(/\b(?:https?|wss?|file|data):[^\s"'<>)\]]+/gi, (m) => url(m));
    s = s.replace(/\bbearer\s+(?!\[REDACTED\])[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]');
    // key=value, `key: value` and JSON `"key":"value"`; a bare `name:word` (an IPC channel such as browser-session:create) is left alone.
    s = s.replace(
      /(?<![A-Za-z0-9_-])(["']?)([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|session(?:id)?|sid|cookie|auth)[A-Za-z0-9_-]*)\1(\s*=\s*|\s*:\s+|(?<=["'])\s*:\s*)(\[REDACTED\]|\[[^\]]*\]|\{[^}]*\}|"[^"]*"|'[^']*'|[^\s&;,'"}\]]+)/gi,
      (m, quote: string, key: string, sep: string, value: string) =>
        value === 'REDACTED' || value === '[REDACTED]' ? m : `${quote}${key}${quote}${sep}[REDACTED]`,
    );
    // Compact `key:value` (no space) only for keys that cannot be a channel or a word: token, secret, password, api key.
    s = s.replace(
      /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key)[A-Za-z0-9_-]*):(?!\s)(\[REDACTED\]|\[[^\]]*\]|\{[^}]*\}|"[^"]*"|'[^']*'|[^\s&;,'"}\]]+)/gi,
      (m, key: string, value: string) => (value === '[REDACTED]' ? m : `${key}:[REDACTED]`),
    );
    return truncate(dropBlobs(dropPaths(s)), MAX_TEXT);
  };

  return {
    url,
    text,
    withSecrets: (more) => makeSanitizer({ ...opts, secrets: [...opts.secrets, ...more] }),
  };
}

/** Cookie and authorization values the fixture servers received: redacted wherever they show up. */
export function secretsFromHeaders(requests: RawServerRequest[]): string[] {
  const out = new Set<string>();
  for (const r of requests) {
    const h = r.headers ?? {};
    for (const [name, raw] of Object.entries(h)) {
      const values = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
      const lower = name.toLowerCase();
      for (const v of values) {
        if (lower === 'authorization' || lower === 'proxy-authorization') {
          out.add(v);
          const parts = v.split(/\s+/);
          if (parts.length > 1) out.add(parts.slice(1).join(' '));
        } else if (lower === 'cookie') {
          // The value only: the cookie name stays readable (`obs_sid=[REDACTED]`).
          for (const pair of v.split(/;\s*/)) {
            const eq = pair.indexOf('=');
            if (eq > 0) out.add(pair.slice(eq + 1));
          }
        }
      }
    }
  }
  return [...out].filter((s) => s.length >= MIN_SECRET_LENGTH);
}

// ---------------------------------------------------------------------------
// classification
// ---------------------------------------------------------------------------
export interface CaseWindow {
  id: string;
  start: number;
  end: number;
}

/** The case whose window holds `ts`; before the first case 'setup', after the last 'teardown', in a gap 'between'. */
export function assignCase(ts: number, windows: CaseWindow[]): string {
  const hit = windows.find((w) => ts >= w.start && ts <= w.end);
  if (hit) return hit.id;
  if (!windows.length || ts < Math.min(...windows.map((w) => w.start))) return 'setup';
  if (ts > Math.max(...windows.map((w) => w.end))) return 'teardown';
  return 'between';
}

const isFavicon = (u?: string) => {
  try {
    return !!u && new URL(u, 'http://x').pathname === '/favicon.ico';
  } catch {
    return false;
  }
};

function originOf(u?: string): string | null {
  if (!u || !/^https?:/i.test(u)) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

export interface BuildOptions {
  windows: CaseWindow[];
  /** Fixture server name -> its origin (server logs carry only the path). */
  serverOrigins: Record<string, string>;
  /** http(s) origins a portal may legitimately reach (the fixture servers). */
  allowedOrigins: string[];
  sanitizer: Sanitizer;
}

export interface CaptureSummary {
  policy: 'report-only';
  rules: typeof FILTER_RULES;
  counts: { console: number; network: number };
  dropped: Record<string, number>;
  answers: { consoleError: boolean; uncaughtException: boolean; failedRequest: boolean; http4xx5xx: boolean; unexpectedRequest: boolean };
  portal: { consoleErrors: number; consoleWarnings: number; uncaughtExceptions: number; unhandledRejections: number; failedRequests: number };
  hostErrors: number;
  http4xx5xx: Array<{ case: string; source: string; context: string; url?: string; status?: number }>;
  failedRequests: Array<{ case: string; source: string; context: string; url?: string; error?: string }>;
  unexpected: Array<{ case: string; rule: string; source: string; url?: string }>;
  failuresByCase: Record<string, number>;
  /** Failures whose context is a portal page, per case: "did the Portal err while the case passed?" is answered against the case status. */
  portalFailuresByCase: Record<string, number>;
}

export function buildRecords(
  raw: RawEvent[],
  requests: RawServerRequest[],
  opts: BuildOptions,
): { console: ConsoleRecord[]; network: NetworkRecord[]; dropped: Record<string, number>; summary: CaptureSummary } {
  const s = opts.sanitizer.withSecrets(secretsFromHeaders(requests));
  const allowed = new Set(opts.allowedOrigins);
  const dropped: Record<string, number> = {};
  const consoleOut: ConsoleRecord[] = [];
  const networkOut: NetworkRecord[] = [];

  type Item = { ts: number; ev?: RawEvent; req?: RawServerRequest };
  const items: Item[] = [...raw.map((ev) => ({ ts: ev.ts, ev })), ...requests.map((req) => ({ ts: req.ts, req }))];
  items.sort((a, b) => a.ts - b.ts); // stable: same-ts items keep their arrival order
  let seq = 0;

  for (const item of items) {
    const caseId = assignCase(item.ts, opts.windows);
    const ts = new Date(item.ts).toISOString();

    if (item.req) {
      const r = item.req;
      const fullUrl = s.url(`${opts.serverOrigins[r.server] ?? ''}${r.url}`);
      let cls: RecordClass = 'event';
      let rule: string | undefined;
      let kind = 'request';
      let error: string | undefined;
      if (r.aborted) {
        kind = 'request-failed';
        error = 'aborted before response';
        cls = 'failure';
      } else if (isFavicon(r.url) && r.status === 404) {
        cls = 'noise';
        rule = 'favicon-404';
      } else if (!r.known) {
        cls = 'failure';
        rule = 'unexpected-request';
      } else if ((r.status ?? 0) >= 400) {
        cls = 'failure';
      }
      networkOut.push({ ts, seq: seq++, case: caseId, source: `fixture-server:${r.server}`, kind, class: cls, rule, context: 'fixture-server', method: r.method, url: fullUrl, status: r.status, error });
      continue;
    }

    const ev = item.ev!;
    const page = `${ev.context}#${ev.wcId}`;
    const pageUrl = ev.pageUrl ? s.url(ev.pageUrl) : undefined;

    if (ev.type === 'console') {
      const level = ev.level;
      if (ev.context === 'host' && level !== 'warning' && level !== 'error') {
        dropped['host-verbose'] = (dropped['host-verbose'] ?? 0) + 1;
        continue;
      }
      const msg = String(ev.message ?? '');
      const kind: ConsoleRecord['kind'] = msg.startsWith('Uncaught (in promise)')
        ? 'unhandled-rejection'
        : msg.startsWith('Uncaught ')
          ? 'uncaught-exception'
          : msg.startsWith('Failed to load resource')
            ? 'resource-error'
            : 'console';
      let cls: RecordClass = level === 'error' ? 'failure' : 'event';
      let rule: string | undefined;
      if (ev.context === 'harness') {
        cls = 'noise';
        rule = 'harness-window';
      } else if (ev.context === 'host' && /^\[ExtensionLoader\] Failed to load [\w.-]+: Main module not found/.test(msg)) {
        cls = 'noise';
        rule = 'fixture-extensions-missing';
      } else if (kind === 'resource-error' && isFavicon(ev.sourceUrl) && /status of 404/.test(msg)) {
        cls = 'noise';
        rule = 'favicon-404';
      } else if (kind === 'resource-error' && /ERR_ABORTED/.test(msg)) {
        cls = 'noise';
        rule = 'aborted-navigation';
      }
      const source = ev.sourceUrl ? `${s.url(ev.sourceUrl)}${typeof ev.line === 'number' ? `:${ev.line}` : ''}` : undefined;
      consoleOut.push({ ts, seq: seq++, case: caseId, kind, level, class: cls, rule, context: ev.context, page, partition: ev.partition, frame: ev.frame, pageUrl, message: s.text(msg), source });

      if (kind === 'resource-error') {
        // The renderer's own report of a subresource that failed (no webRequest): the network view of the same fact.
        const detail = msg.replace(/^Failed to load resource:?\s*/, '');
        const status = /status of (\d{3})/.exec(detail);
        networkOut.push({
          ts,
          seq: seq++,
          case: caseId,
          source: 'renderer-console',
          kind: status ? 'response' : 'request-failed',
          class: cls,
          rule,
          context: ev.context,
          page,
          partition: ev.partition,
          frame: ev.frame,
          url: ev.sourceUrl ? s.url(ev.sourceUrl) : undefined,
          status: status ? Number(status[1]) : undefined,
          error: status ? undefined : s.text(detail),
        });
      }
      continue;
    }

    // webContents navigation events
    let cls: RecordClass = 'event';
    let rule: string | undefined;
    let error: string | undefined;
    if (ev.kind === 'load-failed') error = `${ev.errorDescription ?? 'error'} (${ev.errorCode ?? '?'})`;
    if (ev.kind === 'renderer-gone' || ev.kind === 'preload-error') error = s.text(ev.errorDescription ?? ev.kind);
    if (ev.kind === 'navigation-blocked') error = `blocked at ${ev.errorDescription ?? '?'}`;
    if (ev.context === 'harness') {
      cls = 'noise';
      rule = 'harness-window';
    } else if (ev.kind === 'load-failed') {
      if (ev.errorCode === -3) {
        cls = 'noise';
        rule = 'aborted-navigation';
      } else cls = 'failure';
    } else if (ev.kind === 'renderer-gone' || ev.kind === 'preload-error') {
      cls = 'failure';
    } else if ((ev.status ?? 0) >= 400) {
      if (isFavicon(ev.url) && ev.status === 404) {
        cls = 'noise';
        rule = 'favicon-404';
      } else cls = 'failure';
    } else if (
      (ev.context === 'portal' || ev.context === 'user-tab') &&
      ev.kind !== 'navigation-blocked' &&
      originOf(ev.url) !== null &&
      !allowed.has(originOf(ev.url)!)
    ) {
      cls = 'failure';
      rule = 'unexpected-origin';
    }
    networkOut.push({
      ts,
      seq: seq++,
      case: caseId,
      source: 'webcontents',
      kind: ev.kind,
      class: cls,
      rule,
      context: ev.context,
      page,
      partition: ev.partition,
      frame: ev.frame,
      url: ev.url !== undefined ? s.url(ev.url) : undefined,
      status: ev.status,
      error,
    });
  }

  const portalConsole = consoleOut.filter((r) => r.context === 'portal' && r.class !== 'noise');
  const failedRequests = networkOut.filter((r) => (r.kind === 'request-failed' || r.kind === 'load-failed') && r.class === 'failure');
  const http4xx5xx = networkOut.filter((r) => r.class === 'failure' && (r.status ?? 0) >= 400);
  const unexpected = networkOut.filter((r) => r.rule === 'unexpected-request' || r.rule === 'unexpected-origin');
  const failuresByCase: Record<string, number> = {};
  const portalFailuresByCase: Record<string, number> = {};
  for (const r of [...consoleOut, ...networkOut]) {
    if (r.class !== 'failure') continue;
    failuresByCase[r.case] = (failuresByCase[r.case] ?? 0) + 1;
    if (r.context === 'portal') portalFailuresByCase[r.case] = (portalFailuresByCase[r.case] ?? 0) + 1;
  }

  const summary: CaptureSummary = {
    policy: 'report-only',
    rules: FILTER_RULES,
    counts: { console: consoleOut.length, network: networkOut.length },
    dropped,
    answers: {
      consoleError: consoleOut.some((r) => r.level === 'error' && r.class === 'failure'),
      uncaughtException: consoleOut.some((r) => (r.kind === 'uncaught-exception' || r.kind === 'unhandled-rejection') && r.class === 'failure'),
      failedRequest: failedRequests.length > 0,
      http4xx5xx: http4xx5xx.length > 0,
      unexpectedRequest: unexpected.length > 0,
    },
    portal: {
      consoleErrors: portalConsole.filter((r) => r.level === 'error').length,
      consoleWarnings: portalConsole.filter((r) => r.level === 'warning').length,
      uncaughtExceptions: portalConsole.filter((r) => r.kind === 'uncaught-exception').length,
      unhandledRejections: portalConsole.filter((r) => r.kind === 'unhandled-rejection').length,
      failedRequests: failedRequests.filter((r) => r.context === 'portal').length,
    },
    hostErrors: consoleOut.filter((r) => r.context === 'host' && r.level === 'error' && r.class !== 'noise').length,
    http4xx5xx: http4xx5xx.map((r) => ({ case: r.case, source: r.source, context: r.context, url: r.url, status: r.status })),
    failedRequests: failedRequests.map((r) => ({ case: r.case, source: r.source, context: r.context, url: r.url, error: r.error })),
    unexpected: unexpected.map((r) => ({ case: r.case, rule: r.rule!, source: r.source, url: r.url })),
    failuresByCase,
    portalFailuresByCase,
  };
  return { console: consoleOut, network: networkOut, dropped, summary };
}

/** One JSON object per line, sorted by ts then seq; undefined keys are left out (JSON.stringify). */
export function toJsonl(records: Array<{ ts: string; seq: number }>): string {
  return [...records]
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.seq - b.seq))
    .map((r) => `${JSON.stringify(r)}\n`)
    .join('');
}
