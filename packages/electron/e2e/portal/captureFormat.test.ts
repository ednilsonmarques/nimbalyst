import { describe, expect, it } from 'vitest';
import {
  FILTER_RULES,
  assignCase,
  buildRecords,
  makeSanitizer,
  toJsonl,
  type RawEvent,
  type RawServerRequest,
} from './captureFormat';

const HOME = 'C:\\Users\\jane.doe';
const TMP = 'C:\\Users\\JANE~1\\AppData\\Local\\Temp';
const TMP_LONG = 'C:\\Users\\jane.doe\\AppData\\Local\\Temp';
const REPO = 'C:\\Users\\jane.doe\\code\\nimbalyst\\packages\\electron';
const SECRET = 'mcp-token-0123456789abcdef';

const sanitizer = () =>
  makeSanitizer({ secrets: [SECRET], home: HOME, tmpDirs: [TMP, TMP_LONG], repoRoot: REPO, user: 'jane.doe' });

describe('sanitizeUrl', () => {
  const s = sanitizer();

  it('redacts sensitive query values and keeps the others', () => {
    const out = s.url('http://127.0.0.1:9490/obs.html?token=abc123&q=ok&api_key=K&sessionId=sess-A&password=p&code=xyz');
    expect(out).toContain('q=ok');
    for (const leaked of ['abc123', 'api_key=K', 'sess-A', 'password=p', 'code=xyz']) expect(out).not.toContain(leaked);
    expect(out).toContain('token=REDACTED');
  });

  it('strips user info and redacts fragment parameters', () => {
    const out = s.url('https://user:pw@example.test/cb#access_token=zzz&state=1');
    expect(out).not.toContain('user:pw');
    expect(out).not.toContain('zzz');
    expect(out).toContain('example.test/cb');
  });

  it('removes personal paths from file URLs (long and short forms)', () => {
    const long = s.url('file:///C:/Users/jane.doe/code/nimbalyst/packages/electron/out2/renderer/index.html');
    const short = s.url('file:///C:/Users/JANE~1/AppData/Local/Temp/nib-portal-run-1/x.html');
    expect(long).toBe('file:///<REPO>/out2/renderer/index.html');
    expect(short).toBe('file:///<TEMP>/nib-portal-run-1/x.html');
  });

  it('does not keep data URL bodies', () => {
    expect(s.url('data:text/html,<script>secret()</script>')).toBe('data:text/html,[omitted]');
  });

  it('redacts a known secret wherever it appears', () => {
    expect(s.url(`http://127.0.0.1:9490/p/${SECRET}`)).not.toContain(SECRET);
  });
});

describe('sanitizeText', () => {
  const s = sanitizer();

  it('redacts known secrets, header-like lines, bearer tokens and key=value secrets', () => {
    const out = s.text(`token is ${SECRET}; Authorization: Bearer abc.def.ghi; cookie=fixture_sid=1234; password="hunter2"`);
    for (const leaked of [SECRET, 'abc.def.ghi', 'fixture_sid=1234', 'hunter2']) expect(out).not.toContain(leaked);
    expect(out).toContain('[REDACTED]');
  });

  it('redacts cookie pairs printed by a page (document.cookie)', () => {
    expect(s.text('obs leak document.cookie obs_sid=abc123def; theme=dark')).toBe('obs leak document.cookie obs_sid=[REDACTED]; theme=dark');
  });

  it('redacts a Bearer token outside a header line', () => {
    expect(s.text('send Bearer eyJhbGciOi.payload.sig now')).toBe('send Bearer [REDACTED] now');
  });

  it('removes Windows user paths in every form and the user name', () => {
    const out = s.text(
      `at ${REPO}\\out2\\main\\index.js and C:/Users/JANE~1/AppData/Local/Temp/nib-portal-run-1 and D:\\Users\\other.person\\x and C:\\Users\\jane.doe\\secret.txt by jane.doe`,
    );
    expect(out).not.toMatch(/jane\.doe|JANE~1|other\.person/i);
    expect(out).toContain('<REPO>');
    expect(out).toContain('<TEMP>');
  });

  it('sanitizes URLs embedded in a message', () => {
    const out = s.text('GET http://127.0.0.1:9490/obs-api?api_key=K9 failed');
    expect(out).not.toContain('K9');
    expect(out).toContain('http://127.0.0.1:9490/obs-api');
  });

  it('redacts long opaque blobs and truncates long messages', () => {
    expect(s.text(`x ${'A'.repeat(64)} y`)).toBe('x [REDACTED-BLOB] y');
    const long = s.text('word '.repeat(400));
    expect(long.length).toBeLessThanOrEqual(520);
    expect(long.endsWith('[truncated]')).toBe(true);
  });

  it('leaves ordinary text alone', () => {
    expect(s.text('obs info line 42')).toBe('obs info line 42');
  });

  it('redacts secrets inside JSON (quoted keys)', () => {
    const out = s.text('state {"token":"abcd1234","password":"p@ss","apiKey":"zz9999","authorization":"Bearer qq77"} end');
    for (const leaked of ['abcd1234', 'p@ss', 'zz9999', 'qq77']) expect(out).not.toContain(leaked);
    expect(out).toContain('"token":[REDACTED]');
  });

  it('keeps IPC channel names such as browser-session:create readable', () => {
    expect(s.text('invoke browser-session:create failed')).toBe('invoke browser-session:create failed');
    expect(s.text('session: abc123')).toBe('session: [REDACTED]');
  });

  it('still redacts compact key:value for unambiguous keys', () => {
    const out = s.text('password:hunter2 token:abc12345 secret:xyz99 api_key:k1k1k1');
    for (const leaked of ['hunter2', 'abc12345', 'xyz99', 'k1k1k1']) expect(out).not.toContain(leaked);
  });

  it('redacts whole JSON arrays and objects under a sensitive key', () => {
    const out = s.text('{"tokens":["a1b2","c3d4"],"auth":{"x":"e5f6"},"ok":1}');
    for (const leaked of ['a1b2', 'c3d4', 'e5f6']) expect(out).not.toContain(leaked);
    expect(out).toContain('"ok":1');
  });

  it('only redacts the bare user name as a whole token', () => {
    const short = makeSanitizer({ secrets: [], user: 'dev' });
    expect(short.text('devtools developer dev')).toBe('devtools developer dev');
    const named = makeSanitizer({ secrets: [], user: 'jane.doe' });
    expect(named.text('by jane.doe, not jane.doer')).toBe('by <user>, not jane.doer');
  });
});

describe('sanitizeUrl beyond http(s)', () => {
  const s = sanitizer();
  it('redacts sensitive query values of file: and other URLs, keeping the rest', () => {
    const out = s.url('file:///C:/x/index.html?token=abc1234&theme=dark');
    expect(out).toContain('theme=dark');
    expect(out).not.toContain('abc1234');
    expect(s.url('nim-preview://abc/x?pin=1234&pass=zz&otp=99&ok=1')).toBe('nim-preview://abc/x?pin=REDACTED&pass=REDACTED&otp=REDACTED&ok=1');
  });
  it('redacts an http URL that new URL rejects', () => {
    const out = s.url('http://us:pw@[bad/x?token=abc1234');
    expect(out).not.toContain('abc1234');
    expect(out).not.toContain('us:pw');
  });
});

describe('assignCase', () => {
  const windows = [
    { id: 'C0', start: 100, end: 200 },
    { id: 'C1', start: 210, end: 300 },
  ];
  it('maps a timestamp to its case window, setup, between or teardown', () => {
    expect(assignCase(50, windows)).toBe('setup');
    expect(assignCase(150, windows)).toBe('C0');
    expect(assignCase(205, windows)).toBe('between');
    expect(assignCase(300, windows)).toBe('C1');
    expect(assignCase(301, windows)).toBe('teardown');
    expect(assignCase(1, [])).toBe('setup');
  });
});

describe('buildRecords (classification and filtering)', () => {
  const base = { wcId: 7, context: 'portal' as const, partition: 'agent-portal-1', pageUrl: 'http://127.0.0.1:9490/obs.html?token=t0p' };
  const consoleEv = (ts: number, level: string, message: string, sourceUrl?: string, context: RawEvent['context'] = 'portal'): RawEvent => ({
    type: 'console',
    ts,
    ...base,
    context,
    level,
    message,
    sourceUrl,
    line: 3,
    frame: 'main',
  });
  const net = (ts: number, kind: string, extra: Partial<RawEvent> = {}): RawEvent => ({ type: 'net', ts, ...base, kind, ...extra }) as RawEvent;
  const server = (ts: number, url: string, status?: number, known = true, aborted = false): RawServerRequest => ({
    server: 's1',
    ts,
    method: 'GET',
    url,
    status,
    known,
    aborted,
    headers: { authorization: 'Bearer hdr-secret-value', cookie: 'fixture_sid=cookievalue1' },
  });
  const opts = {
    windows: [{ id: 'OBS', start: 0, end: 10_000 }],
    serverOrigins: { s1: 'http://127.0.0.1:9490', other: 'http://127.0.0.1:9491' },
    allowedOrigins: ['http://127.0.0.1:9490', 'http://127.0.0.1:9491'],
    sanitizer: sanitizer(),
  };

  const raw: RawEvent[] = [
    consoleEv(10, 'info', 'obs log line'),
    consoleEv(11, 'warning', 'obs warn line'),
    consoleEv(12, 'error', 'obs error line'),
    consoleEv(13, 'error', 'Uncaught Error: obs uncaught'),
    consoleEv(14, 'error', 'Uncaught (in promise) Error: obs rejection'),
    consoleEv(15, 'error', 'Failed to load resource: net::ERR_CONNECTION_REFUSED', 'http://127.0.0.1:1/obs-refused.png'),
    consoleEv(16, 'error', 'Failed to load resource: the server responded with a status of 404 (Not Found)', 'http://127.0.0.1:9490/favicon.ico'),
    consoleEv(17, 'info', 'host chatter', undefined, 'host'),
    consoleEv(18, 'debug', 'host debug', undefined, 'host'),
    consoleEv(19, 'error', 'host error', undefined, 'host'),
    consoleEv(20, 'info', 'probe window line', undefined, 'harness'),
    consoleEv(21, 'error', '[ExtensionLoader] Failed to load com.nimbalyst.math: Main module not found at C:\\x\\dist\\index.js', undefined, 'host'),
    consoleEv(22, 'error', '[ExtensionLoader] Failed to load com.nimbalyst.math: manifest is invalid', undefined, 'host'),
    net(30, 'response', { url: 'http://127.0.0.1:9490/obs.html?token=t0p', status: 200, frame: 'main' }),
    net(31, 'load-failed', { url: 'http://127.0.0.1:9491/top', errorCode: -3, errorDescription: 'ERR_ABORTED', frame: 'main' }),
    net(32, 'load-failed', { url: 'http://127.0.0.1:1/x', errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', frame: 'sub' }),
    net(33, 'navigation-blocked', { url: 'http://127.0.0.1:9491/top-1', frame: 'main' }),
    net(34, 'response', { url: 'https://evil.test/', status: 200, frame: 'main' }),
    net(35, 'renderer-gone', { errorDescription: 'crashed' }),
  ];
  const requests: RawServerRequest[] = [
    server(40, '/obs-api?api_key=K', 200),
    server(41, '/obs-500', 500),
    server(42, '/favicon.ico', 404, false),
    server(43, '/nope', 404, false),
    server(44, '/slow', undefined, true, true),
  ];
  const out = buildRecords(raw, requests, opts);
  const c = (msg: string) => out.console.find((r) => r.message.includes(msg));
  const n = (pred: (r: (typeof out.network)[number]) => boolean) => out.network.find(pred);

  it('keeps portal console levels and classifies them', () => {
    expect(c('obs log line')).toMatchObject({ kind: 'console', level: 'info', class: 'event', context: 'portal', case: 'OBS', page: 'portal#7' });
    expect(c('obs warn line')).toMatchObject({ level: 'warning', class: 'event' });
    expect(c('obs error line')).toMatchObject({ level: 'error', class: 'failure' });
    expect(c('obs uncaught')).toMatchObject({ kind: 'uncaught-exception', class: 'failure' });
    expect(c('obs rejection')).toMatchObject({ kind: 'unhandled-rejection', class: 'failure' });
  });

  it('turns resource load failures into console resource-error and a network request-failed', () => {
    expect(c('ERR_CONNECTION_REFUSED')).toMatchObject({ kind: 'resource-error', class: 'failure' });
    expect(n((r) => r.kind === 'request-failed' && r.source === 'renderer-console' && r.url === 'http://127.0.0.1:1/obs-refused.png')).toMatchObject({
      class: 'failure',
      error: 'net::ERR_CONNECTION_REFUSED',
    });
  });

  it('applies the explicit noise rules and drops host verbosity, without hiding host errors', () => {
    expect(c('status of 404')).toMatchObject({ class: 'noise', rule: 'favicon-404' });
    expect(c('host chatter')).toBeUndefined();
    expect(c('host debug')).toBeUndefined();
    expect(c('host error')).toMatchObject({ context: 'host', class: 'failure' });
    expect(c('probe window line')).toMatchObject({ class: 'noise', rule: 'harness-window' });
    expect(c('Main module not found')).toMatchObject({ context: 'host', class: 'noise', rule: 'fixture-extensions-missing' });
    expect(c('manifest is invalid')).toMatchObject({ context: 'host', class: 'failure' });
    expect(out.dropped['host-verbose']).toBe(2);
    expect(FILTER_RULES.map((r) => r.id)).toEqual(expect.arrayContaining(['host-verbose', 'harness-window', 'favicon-404', 'aborted-navigation', 'unexpected-request', 'unexpected-origin']));
  });

  it('classifies navigation events', () => {
    expect(n((r) => r.kind === 'response' && r.status === 200 && r.source === 'webcontents' && r.url.includes('obs.html'))).toMatchObject({
      class: 'event',
      url: 'http://127.0.0.1:9490/obs.html?token=REDACTED',
      frame: 'main',
    });
    expect(n((r) => r.kind === 'load-failed' && r.error === 'ERR_ABORTED (-3)')).toMatchObject({ class: 'noise', rule: 'aborted-navigation' });
    expect(n((r) => r.kind === 'load-failed' && r.error === 'ERR_CONNECTION_REFUSED (-102)')).toMatchObject({ class: 'failure' });
    expect(n((r) => r.kind === 'navigation-blocked')).toMatchObject({ class: 'event' });
    expect(n((r) => r.url === 'https://evil.test/')).toMatchObject({ class: 'failure', rule: 'unexpected-origin' });
    expect(n((r) => r.kind === 'renderer-gone')).toMatchObject({ class: 'failure' });
  });

  it('records fixture server requests with status and classification', () => {
    const viaServer = out.network.filter((r) => r.source === 'fixture-server:s1');
    expect(viaServer.find((r) => r.url.endsWith('/obs-api?api_key=REDACTED'))).toMatchObject({ kind: 'request', method: 'GET', status: 200, class: 'event', context: 'fixture-server' });
    expect(viaServer.find((r) => r.url.endsWith('/obs-500'))).toMatchObject({ status: 500, class: 'failure' });
    expect(viaServer.find((r) => r.url.endsWith('/favicon.ico'))).toMatchObject({ class: 'noise', rule: 'favicon-404' });
    expect(viaServer.find((r) => r.url.endsWith('/nope'))).toMatchObject({ class: 'failure', rule: 'unexpected-request' });
    expect(viaServer.find((r) => r.url.endsWith('/slow'))).toMatchObject({ kind: 'request-failed', error: 'aborted before response', class: 'failure' });
  });

  it('never writes headers, and redacts the cookie and authorization values the servers saw', () => {
    const text = toJsonl(out.network) + toJsonl(out.console);
    expect(text).not.toMatch(/headers|authorization|hdr-secret-value|cookievalue1/i);
    // the cookie value the server saw is redacted where a page prints it; the cookie name stays readable
    const printed = buildRecords([consoleEv(1, 'info', 'cookie dump fixture_sid=cookievalue1 end')], requests, opts);
    expect(printed.console[0].message).toBe('cookie dump fixture_sid=[REDACTED] end');
    for (const r of [...out.network, ...out.console]) expect(Object.keys(r)).not.toContain('headers');
  });

  it('summarises the failure questions without deciding a policy', () => {
    expect(out.summary).toMatchObject({
      policy: 'report-only',
      portal: { consoleErrors: 4, uncaughtExceptions: 1, unhandledRejections: 1, failedRequests: 2 },
    });
    expect(out.summary.http4xx5xx).toEqual(expect.arrayContaining([expect.objectContaining({ url: 'http://127.0.0.1:9490/obs-500', status: 500 })]));
    expect(out.summary.unexpected.map((u) => u.rule).sort()).toEqual(['unexpected-origin', 'unexpected-request']);
    // portal console failures (4) + portal network failures (refused png, -102 load, evil origin, renderer gone)
    expect(out.summary.portalFailuresByCase).toEqual({ OBS: 8 });
    // host errors: 'host error' and the invalid manifest; the labelled missing-extension line is noise
    expect(out.summary.hostErrors).toBe(2);
  });

  it('labels a blocked navigation with the event that blocked it', () => {
    const blocked = buildRecords([net(1, 'navigation-blocked', { url: 'http://127.0.0.1:9491/x', errorDescription: 'will-redirect', frame: 'sub' })], [], opts);
    expect(blocked.network[0]).toMatchObject({ kind: 'navigation-blocked', class: 'event', error: 'blocked at will-redirect', frame: 'sub' });
  });
});

describe('toJsonl', () => {
  it('is deterministic: sorted by ts then seq, fixed key order, no undefined keys', () => {
    const a = { ts: '2026-01-01T00:00:00.002Z', seq: 2, kind: 'x', extra: undefined };
    const b = { ts: '2026-01-01T00:00:00.001Z', seq: 1, kind: 'y' };
    const out = toJsonl([a, b]);
    expect(out).toBe('{"ts":"2026-01-01T00:00:00.001Z","seq":1,"kind":"y"}\n{"ts":"2026-01-01T00:00:00.002Z","seq":2,"kind":"x"}\n');
    expect(toJsonl([b, a])).toBe(out);
  });
});
