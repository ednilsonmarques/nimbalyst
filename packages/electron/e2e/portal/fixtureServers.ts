/**
 * Two local HTTP servers for the Portal fixture. Nothing leaves loopback.
 *
 *  - S1 ("the preview") serves the tiny static site and the hostile pages.
 *  - S2 ("the other origin") is a different origin (another port). Every request
 *    it receives is logged, so "navigation blocked" can be asserted as "S2 never
 *    saw a page request", and "subresource allowed" as "S2 saw the fetch".
 *
 * Ports are taken from 9490-9499 (never 9222).
 */
import * as crypto from 'crypto';
import * as http from 'http';
import * as os from 'os';

export interface RecordedRequest {
  method: string;
  url: string;
  /** Kept in memory for the cases; the capture (F1.3a) reads them only to learn what to redact and never writes them. */
  headers: http.IncomingHttpHeaders;
  /** Arrival time (ms), status once the response finished, `aborted` when the connection closed first. */
  ts: number;
  status?: number;
  aborted: boolean;
  /** false when the server has no route for the path (the 404 default). */
  known: boolean;
}

/** Records a request and fills in its status (or `aborted`) when the response ends. Observes only. */
function record(requests: RecordedRequest[], req: http.IncomingMessage, res: http.ServerResponse): RecordedRequest {
  const rec: RecordedRequest = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, ts: Date.now(), aborted: false, known: true };
  requests.push(rec);
  res.on('finish', () => {
    rec.status = res.statusCode;
  });
  res.on('close', () => {
    if (!res.writableFinished) rec.aborted = true;
  });
  return rec;
}

/**
 * Values the OBS case (F1.3a) plants in its page, its requests and its console output. None of them may reach the
 * capture artifacts. `known` is the only one the capture is told about (as a known secret of the run); the others
 * must be caught by the generic redaction rules.
 */
const canary = (label: string) => `nibcanary${label}${crypto.randomBytes(6).toString('hex')}`;
export const OBS_CANARIES = {
  query: canary('query'),
  bearer: canary('bearer'),
  cookie: canary('cookie'),
  header: canary('header'),
  apiKey: canary('apikey'),
  password: canary('password'),
  known: canary('known'),
} as const;

/** OBS page script: one of each console level, an uncaught exception, an unhandled rejection, and requests that succeed, fail, redirect and are refused. */
function obsScript(): string {
  const c = OBS_CANARIES;
  const homePath = JSON.stringify(`${os.homedir()}\\obs-secret.txt`);
  const user = JSON.stringify(os.userInfo().username);
  return `
window.__obs = { done: false };
(async () => {
  const dead = new URLSearchParams(location.search).get('dead');
  console.log('obs log line');
  console.info('obs info line');
  console.warn('obs warn line');
  console.error('obs error line');
  console.debug('obs debug line');
  console.log('obs leak header Authorization: Bearer ${c.bearer}');
  console.log('obs leak kv password=${c.password}');
  console.log('obs leak plain ${c.known}');
  console.log('obs leak path ' + ${homePath} + ' user ' + ${user});
  document.cookie = 'obs_sid=${c.cookie}; path=/';
  console.log('obs leak document.cookie ' + document.cookie);
  const r = {};
  try { r.api = (await fetch('/obs-api?api_key=${c.apiKey}&q=ok', { headers: { Authorization: 'Bearer ${c.header}' } })).status; } catch (e) { r.api = 'error'; }
  try { r.err500 = (await fetch('/obs-500')).status; } catch (e) { r.err500 = 'error'; }
  try { r.redirect = (await fetch('/redir?to=%2Fobs-api%3Fafter%3Dredirect')).status; } catch (e) { r.redirect = 'error'; }
  try { await fetch(dead + '/obs-refused-fetch'); r.refusedFetch = 'resolved'; } catch (e) { r.refusedFetch = 'rejected'; }
  r.refusedImg = await new Promise((res) => { const i = new Image(); i.onload = () => res('load'); i.onerror = () => res('error'); i.src = dead + '/obs-refused.png'; });
  r.frame = await new Promise((res) => { const f = document.createElement('iframe'); f.onload = () => res('load'); f.src = '/redir?to=%2Fframe-doc%3Fobs%3D1'; document.body.appendChild(f); setTimeout(() => res('timeout'), 4000); });
  setTimeout(() => { throw new Error('obs uncaught exception'); }, 0);
  Promise.reject(new Error('obs unhandled rejection'));
  await new Promise((res) => setTimeout(res, 100));
  window.__obs = Object.assign({ done: true }, r);
})();
`;
}

export interface FixtureServer {
  port: number;
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const PORT_RANGE = [9490, 9491, 9492, 9493, 9494, 9495, 9496, 9497, 9498, 9499];

/**
 * Origins the fixture owns: its port range, plus port 1 (C4's popup target; Chromium refuses it as an unsafe port,
 * ERR_UNSAFE_PORT, before any connection). A portal that reaches anything else is "unexpected" for the capture.
 */
export const FIXTURE_ORIGINS = [...PORT_RANGE.map((p) => `http://127.0.0.1:${p}`), 'http://127.0.0.1:1'];

/**
 * An origin in the fixture's range with nothing listening: a port is bound and released here, so it is known free
 * and a request to it gets a real "connection refused" (ERR_CONNECTION_REFUSED). Used by the OBS case only.
 */
export async function deadOrigin(): Promise<string> {
  const server = http.createServer();
  const port = await listenOnFreePort(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

async function listenOnFreePort(server: http.Server): Promise<number> {
  for (const port of PORT_RANGE) {
    const ok = await new Promise<boolean>((resolve) => {
      const onError = () => resolve(false);
      server.once('error', onError);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', onError);
        resolve(true);
      });
    });
    if (ok) return port;
  }
  throw new Error('No free port in 9490-9499');
}

const page = (title: string, body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`;

/** Runs on load in the portal: asks the browser for everything an agent portal must refuse. */
const HOSTILE_SCRIPT = `
window.__hostile = { done: false };
(async () => {
  const r = window.__hostile;
  const rej = async (p) => { try { await p; return 'resolved'; } catch (e) { return (e && e.name) + ':' + (e && e.message || '').slice(0, 80); } };
  r.permissionsQuery = {};
  for (const name of ['geolocation', 'notifications', 'camera', 'microphone', 'midi', 'clipboard-read']) {
    try { r.permissionsQuery[name] = (await navigator.permissions.query({ name })).state; } catch (e) { r.permissionsQuery[name] = 'error:' + e.name; }
  }
  r.geolocation = await new Promise((res) => {
    navigator.geolocation.getCurrentPosition(() => res('granted'), (e) => res('error code ' + e.code), { timeout: 4000 });
  });
  r.notification = await Notification.requestPermission();
  r.getUserMediaAudio = await rej(navigator.mediaDevices.getUserMedia({ audio: true }));
  r.getUserMediaVideo = await rej(navigator.mediaDevices.getUserMedia({ video: true }));
  r.hasUsb = typeof navigator.usb; r.hasHid = typeof navigator.hid; r.hasSerial = typeof navigator.serial; r.hasBluetooth = typeof navigator.bluetooth;
  r.done = true;
})();
`;

export async function startPrimaryServer(otherOrigin: () => string): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    const rec = record(requests, req, res);
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
      res.end(body);
    };
    switch (url.pathname) {
      case '/':
        return send(200, 'text/html', page('Fixture index', '<h1>index</h1><button id="btn" onclick="document.title=\'clicked\'">btn</button><input id="inp" oninput="document.title=\'typed:\'+this.value">'));
      case '/hostile.html':
        return send(200, 'text/html', page('hostile', '<p>hostile</p>', HOSTILE_SCRIPT));
      case '/set-cookie':
        return send(200, 'text/html', page('cookie', 'cookie set'), { 'Set-Cookie': `fixture_sid=${url.searchParams.get('v') ?? 'x'}; Path=/` });
      case '/redir': // 302 to ?to=
        return send(302, 'text/plain', 'redirect', { Location: url.searchParams.get('to') ?? '/' });
      case '/download':
        return send(200, 'application/octet-stream', 'nib-portal-fixture-download', {
          'Content-Disposition': 'attachment; filename="nib-portal-fixture-download.txt"',
        });
      case '/popup.html':
        return send(200, 'text/html', page('popup', '<a id="blank" target="_blank" href="http://127.0.0.1:1/never">blank</a>'));
      case '/frame-other.html': // sub-frame that starts on the other origin
        return send(200, 'text/html', page('frame-other', `<iframe id="f" src="${otherOrigin()}/frame-doc"></iframe>`));
      case '/frame-same.html': // same-origin sub-frame the test later points at the other origin
        return send(200, 'text/html', page('frame-same', '<iframe id="f" src="/frame-doc"></iframe>'));
      case '/frame-doc':
        return send(200, 'text/html', page('frame-doc', 'frame doc'));
      case '/subresource.html': // fetches the other origin from the page: allowed (user's decision)
        return send(200, 'text/html', page('subresource', 'sub', `fetch('${otherOrigin()}/api',{mode:'no-cors'}).then(()=>{window.__fetched='ok'}).catch((e)=>{window.__fetched='err:'+e.message});`));
      case '/idb.html':
        return send(200, 'text/html', page('idb', 'idb'));
      case '/sw.js':
        return send(200, 'application/javascript', "self.addEventListener('fetch',()=>{});");
      case '/obs.html': // F1.3a: known console and network stimuli for the capture
        return send(200, 'text/html', page('obs', '<p>obs</p>', obsScript()));
      case '/obs-api':
        return send(200, 'application/json', '{"ok":true}');
      case '/obs-500':
        return send(500, 'text/plain', 'obs server error');
      default:
        rec.known = false;
        return send(404, 'text/plain', 'not found');
    }
  });
  const port = await listenOnFreePort(server);
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export async function startOtherServer(): Promise<FixtureServer> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    record(requests, req, res);
    res.writeHead(200, { 'Content-Type': 'text/html', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><title>OTHER ORIGIN</title><p>other origin reached</p>');
  });
  const port = await listenOnFreePort(server);
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
