// @vitest-environment node
/**
 * Portal F1.2 -- no MCP or agent code path can set the test-data mark, the
 * interaction ports, or open the native confirmation. The setters live behind two
 * IPC channels registered by portalTestData.ts; the agent-facing code (mcp/, the
 * voice tool paths, the browser IPC) may only READ through the assert functions.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const MAIN = path.resolve(__dirname, '../..');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      out.push(...sources(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const FORBIDDEN = /PORTAL_TEST_DATA_SET|PORTAL_INTERACTION_PORTS_SET|portal:set-test-data|portal:set-interaction-ports|portalMarkConfirmation|confirmPortalMark|registerPortalTestDataHandlers|portalInteractionPorts|portalTestData\s*[:=]/;

describe('agent-reachable code never writes the mark or the ports or opens the dialog', () => {
  const agentSide = [
    ...sources(path.join(MAIN, 'mcp')),
    ...sources(path.join(MAIN, 'services/voice')),
    path.join(MAIN, 'ipc/BrowserSessionHandlers.ts'),
    path.join(MAIN, 'services/BrowserSessionService.ts'),
    path.join(MAIN, 'services/BrowserAuthority.ts'),
    path.join(MAIN, 'services/BrowserAgentFiles.ts'),
  ];

  it('scans a real set of files', () => {
    expect(agentSide.length).toBeGreaterThan(20);
  });

  it.each(agentSide.map((f) => [path.relative(MAIN, f), f]))('%s', (_name, file) => {
    expect(fs.readFileSync(file as string, 'utf8')).not.toMatch(FORBIDDEN);
  });

  it('only portalTestData.ts and the confirmation module reference the dialog', () => {
    const users = sources(MAIN)
      .filter((f) => /confirmPortalMark|portalMarkConfirmation/.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(MAIN, f).replace(/\\/g, '/'))
      .sort();
    expect(users).toEqual(['services/portalMarkConfirmation.ts', 'services/portalTestData.ts']);
  });
});
