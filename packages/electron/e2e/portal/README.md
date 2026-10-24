# Portal fixture (M-9): real Electron, isolated profile

Gate before agents may use the Portal. Covers F0-F1.2 (cases C0-C8 in `portal.fixture.spec.ts`;
C9, capture of the first request, belongs to F1.3 and is marked NOT RUN). Case EXT covers a page-initiated navigation
to an unregistered external scheme (script, link click, iframe) and the permissions C4 collects but does not assert
(clipboard-read, midi) plus fullscreen. Case OBS checks the test-side console and network capture (F1.3a, see below).

Only `playwright.portal.config.ts` runs it. The default configs (`playwright.config.ts`,
`playwright-extension.config.ts`) have `testIgnore: '**/e2e/portal/**'`, and the spec skips itself unless
that config set `NIMBALYST_PORTAL_FIXTURE=1`. Check: `npx playwright test --list` lists nothing from `e2e/portal`.

## Isolation rules (enforced by `isolatedLaunch.ts` and `runGuard.ts`; the spec has no other way to launch the app)

- The app runs from a **separate build**, `packages/electron/out2` (never `out/`, which `electron-vite dev` uses).
- `NIMBALYST_USER_DATA_DIR` and `NIMBALYST_USER_DATA_PATH` point into a fresh `%TEMP%\nib-portal-run-*\nib-portal-*`;
  analytics is written off before the first start; `APPDATA`/`LOCALAPPDATA`/`USERPROFILE`/`HOME` point into the same tree.
  Variables for providers, credentials and services (`CLAUDE*`, `CODEX*`, `ANTHROPIC*`, `OPENAI*`, `GH_*`, `XDG_*`, proxies, ...)
  are dropped; the list for a run is in `results.json` -> `evidence.droppedEnv`.
- `NODE_ENV=production`: an unpackaged main otherwise opens a CDP port (9222 by default) of its own. The wrapper adds no
  debugging switch. Playwright's own channel (an ephemeral loopback port) is allowed for this unpackaged test run only.
- Local servers use ports 9490-9499 only. Never 9222.

## Registry (`HKCU\Software\Classes\nimbalyst`)

Every launch of the app rewrites it. The runner process (which outlives its workers) guards it:

- `globalSetup`: `reg export` WITHOUT `/y` (an existing backup is never overwritten) to `$PORTAL_FIXTURE_DIR\reg-backup-run.reg`
  (a new name if one exists and the registry is fine). **Refuses to start** when the registry already points at a test build
  (`out2`/`nib-portal`): it prints the exact `reg import` command and leaves the backup untouched.
- After each launch (`shutdown`), in `globalTeardown`, and synchronously on `exit`/`SIGINT`/`SIGTERM`: import first; only if
  leftovers remain, delete the key and import again. A failed import never leaves the key missing.
- `globalTeardown` kills only the app trees whose PID this run recorded, verifies the restore with a SHA-256 of a fresh export
  against the backup (`registry-hashes.txt`), renames the backup to `reg-backup-run.restored-<ts>.reg`, removes the run's temp root, and
  **throws** (fails the run) on any leftover: unrestored registry, surviving process, temp root not removed.
- `afterAll` of the spec also throws when the registry was not restored or a process of the app tree survived.

### Which processes may be killed (`processSelect.ts`, unit-tested)

Nothing is killed by PID alone (Windows reuses PIDs and never updates `ParentProcessId`). The run records
`pid + CreationDate + ExecutablePath` of the app tree at launch. Before any kill (teardown, `shutdown()`, and the
Ctrl+C/SIGTERM handler) the process is re-queried and killed only if: its creation time equals the recorded one; a child is
younger than its parent; its executable is the repo's `electron.exe` (or a helper the app starts, the Codex app-server under
`node_modules/@openai`, which is reached only through its recorded identity or as a younger child of a vetted process); and its
command line names `out2` or this run's temp root. Anything that fails is NOT killed and, if still running, is
reported as a leftover that fails the run. Playwright's `cmd.exe` launcher is such a refusal at launch; it exits with the app.

What really separates the fixture's app from a developer's dev app: both run the **same `electron.exe`**, so the executable proves
nothing. The protection is the creation-time ordering plus the `out2` / run-temp-root marker in the command line. Keep `out2`
exclusive to this fixture (never run a dev app from it). A `--remote-debugging-port=9222` deny also exists, but it is
**defense in depth only**: the dev app sets that port with `appendSwitch`, so the flag is not on the OS command line and the check
would not see it.

Ctrl+C / SIGTERM: the handler kills the recorded trees first (synchronously, same checks), then restores the registry. In the
runner it does not call `process.exit` (Playwright's own handling finishes the run and still runs `globalTeardown`); a worker exits.

**Unit tests of the harness** (`processes.test.ts`, `captureFormat.test.ts`): they live outside the package vitest include (`src/**`) and outside
`tsconfig`, so **no default gate (`test:prepush`, `typecheck`, `test:e2e`) runs them**. Run them by hand after touching the
harness, with their own config:

```powershell
cd packages/electron
npx vitest run -c e2e/portal/vitest.config.ts --maxWorkers=1 --no-file-parallelism
```

### Manual restore (if the RUNNER is SIGKILLed, the machine dies, or setup refused)

```powershell
reg import "<PORTAL_FIXTURE_DIR>\reg-backup-run.reg"
reg query "HKCU\Software\Classes\nimbalyst\shell\open\command" /ve   # must show the developer's own electron + packages\electron
```

If the import left extra values behind: `reg delete "HKCU\Software\Classes\nimbalyst" /f` and import again. Then move the backup away
before the next run. Also kill any `electron.exe` whose command line contains `out2\main\index.js` (only those).

### Testing the guard itself

`NIMBALYST_PORTAL_SIMULATE_WORKER_CRASH=1` makes the worker SIGKILL itself 7 s after the app started (registry already rewritten,
before any `finally`); `globalTeardown` must restore the registry, kill the orphan app and fail the run.

## Build (the exact commands; there is no npm script for it, on purpose: no change to package.json)

```powershell
cd packages/electron
$env:NODE_OPTIONS = "--max-old-space-size=8192"
npx electron-vite build --outDir=out2
# electron-vite resolves the relative --outDir against the renderer root for the renderer bundle:
Copy-Item -Recurse src/renderer/out2/renderer out2/renderer
Remove-Item -Recurse -Force src/renderer/out2
# the app reads its database/sqlite workers from out/*.bundle.js itself (read only); copy them next to out2 for completeness
Copy-Item out/*.bundle.js, out/pglite.data, out/pglite.wasm out2/

# the Browser extension's dist is not built in the repo; build it OUTSIDE the repo for the legacy browser_* cases:
cd ../extensions/browser
npx vite build --outDir "$env:TEMP/nib-portal-extbuild/com.nimbalyst.browser/dist" --emptyOutDir
Copy-Item manifest.json "$env:TEMP/nib-portal-extbuild/com.nimbalyst.browser/manifest.json"
```

## Run

```powershell
cd packages/electron
$env:PORTAL_FIXTURE_DIR = "<where to keep reg-backup-run.reg and registry-hashes.txt>"
$env:PORTAL_FIXTURE_RESULTS = "<results.json>"
npx playwright test -c playwright.portal.config.ts
```

Before and after, list `%APPDATA%\@nimbalyst\electron` and the real DB mtime.

## Console and network capture (F1.3a, test-only: `capture.ts`, `captureFormat.ts`, case OBS)

What the portal pages print and load is recorded while the cases run, without touching product code.

- **How it observes:** listeners installed in main through `electronApp.evaluate` on every web contents (`console-message`,
  `did-start-navigation`, `did-redirect-navigation`, `did-frame-navigate`, `did-fail-load`, `render-process-gone`,
  `preload-error`, and `will-navigate` / `will-frame-navigate` / `will-redirect` read back after the product's guard to record
  blocked navigations), plus the fixture servers' request logs (method, path, status, arrival time). **Never** `session.webRequest`
  (one listener per event: it would replace the product's guards), no debugging port, no `preventDefault`, nothing injected into a page.
  Which page an event came from is resolved when it happens: `portal` (an `agent-portal-*` partition), `user-tab`
  (`browser-preview`), `harness` (a window the test opened), `host` (the app's own window), `fixture-server`.
- **Artifacts:** `%TEMP%\nib-portal-capture\` (or `PORTAL_FIXTURE_CAPTURE_DIR`, which must be under `%TEMP%`; never the repo):
  `portal-console.jsonl`, `portal-network.jsonl` (one JSON object per line, sorted by time) and `portal-capture-summary.json`.
  Rewritten after every case, so a crashed run still leaves what it saw. They are evidence and are not removed by the teardown.
  Fields: `ts`, `seq`, `case`, `kind`, `level`, `class`, `rule`, `context`, `page`, `partition`, `frame`, `pageUrl`, `message`,
  `source` (console); `ts`, `seq`, `case`, `source`, `kind`, `class`, `rule`, `context`, `page`, `partition`, `frame`, `method`, `url`,
  `status`, `error` (network).
- **Redaction (before anything is written):** headers are never written. Cookie and authorization values the fixture servers
  received, the MCP token and other known secrets are replaced wherever they appear; sensitive query and fragment values
  (`token`, `key`, `secret`, `password`, `session`, `code`, `sig`, ...), user info in URLs, `Authorization`/`Cookie` lines, bearer
  tokens, `key=value` secrets, opaque blobs of 40+ characters, data URL bodies, the temp dir, the repo, the home dir and the user name
  are redacted (also inside JSON text and in the query of `file:` and other URLs). Messages are cut at 500 characters, URLs at 300.
- **Bounds:** 20,000 buffered events in main between drains, 100,000 in the test process, 5,000 lines per file, 100 entries per
  summary list; whatever is cut is counted in `capture` of the summary (`mainDropped`, `rawDropped`, `linesDropped`,
  `summaryListsCut`). A drain that does not answer in 10 s is recorded as a `drainErrors` entry, so the shutdown is always reached.
- **Filtering (`FILTER_RULES`, written into the summary):** `class` is `failure` (console error, uncaught exception or rejection,
  failed load, HTTP >= 400, unexpected request or origin, renderer gone), `noise` (a named rule: `harness-window`,
  `fixture-extensions-missing`, `favicon-404`, `aborted-navigation`; kept in the file, labelled) or `event`. The only thing
  dropped is the host window's info/debug output (counted in `dropped`); its warnings and errors are kept.
- **Failure policy: report-only.** The capture never fails a case. The summary answers: console error? uncaught exception?
  failed request? 4xx/5xx? unexpected request? `results.json` -> `evidence.capture.portalErrorsInPassingCases` lists portal
  failures inside cases that passed. The **OBS** case checks the capture itself against a page of known stimuli
  (`/obs.html`: each console level, an uncaught exception, an unhandled rejection, a fetch, a 500, a redirect, a frame
  redirect, refused requests, planted secrets) and fails only if the capture misses or leaks them.
- **Limits:** a subresource (fetch, img) that fails before reaching a server (connection refused) is NOT observable:
  Chromium keeps its "Failed to load resource" line for DevTools and does not emit it as `console-message` (seen in
  Electron 43); seeing it would need `webRequest`, CDP or a NetLog. Subresources that reach a fixture server are seen in its log,
  but the log cannot tell which page sent them. Failed document and frame loads are observable. `console.log` and
  `console.info` arrive at the same level (`info`). Port 1 is refused by Chromium as an unsafe port (`ERR_UNSAFE_PORT`),
  not by the network; OBS uses a released port of the fixture range for a real "connection refused". A page whose session
  was not obtained through `session.fromPartition` is labelled `other`, not `portal` (today every portal goes through it).

## Known limits

- A real Ctrl+C on the runner was not exercised (only the shared kill-then-restore body, through the simulated worker crash).
- An orphan whose parent already died (for example the Codex app-server after the app's main process crashed) is not reached by
  the tree walk: children are found by `ParentProcessId`, which needs the parent alive and recorded. Only what was recorded at launch,
  or is a living descendant of it, can be killed.
- The `--remote-debugging-port=9222` deny is decorative (see above); the creation-time ordering and the `out2` / temp-root marker
  are the real protection, and `out2` must stay exclusive to the fixture.
- The registry count (`agentPartitionCount`) is not observable from outside the bundle; the expired-token case and the reaper /
  window-closed / failed-create wipe paths are not exercised in real Electron (see the fixture report).
- Windows only (registry, PowerShell process queries).

- EXT uses an unregistered scheme on purpose: a registered one (`mailto:`, `ms-settings:`) could open a real application if
  the guard ever failed. It first checks `HKCR\nib-fixture-unregistered` and does not navigate if a handler exists. The
  positive proof that the guard stopped each navigation is the capture's `navigation-blocked` record; if the guard ever failed,
  Windows could still show its "look for an app" prompt. In an agent portal on Electron 43, `requestFullscreen()` was observed to
  stay pending (neither granted nor rejected); EXT asserts that neither the page nor any window becomes fullscreen.
- Observed in C5 on every run: after the product blocks the INITIAL redirect of a new portal, its renderer logs
  `Cannot destructure property 'preloadScripts' of 'binding.startupData'`. Probably the cancelled first navigation leaves the
  blank sandboxed renderer without startup data (an inference, not proven); the capture reports it.

## Pending (recorded, not implemented)

- The wipe of storage when the portal's create fails (product change), and the wipe through the reaper or a closed window
  (not exercised: the reaper runs after 5 minutes).
- The user tab keeping today's permissions, downloads and external popup (F1.1 plan item 10): only the popup is checked (C4).
