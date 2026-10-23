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
import * as http from 'http';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}

export interface FixtureServer {
  port: number;
  origin: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

const PORT_RANGE = [9490, 9491, 9492, 9493, 9494, 9495, 9496, 9497, 9498, 9499];

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
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });
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
      default:
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
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers });
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
