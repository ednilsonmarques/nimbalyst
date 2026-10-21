// @vitest-environment node
import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { isRendererEvalAvailable } from '../rendererEvalGate';

describe('renderer_eval availability (HTML audit, item 5b)', () => {
  it('is offered in an unpackaged development run', () => {
    expect(isRendererEvalAvailable({ nodeEnv: 'development', isPackaged: false })).toBe(true);
    expect(isRendererEvalAvailable({ rendererUrl: 'http://localhost:5273', isPackaged: false })).toBe(true);
  });

  it('is never offered by a packaged build, whatever the environment says', () => {
    expect(isRendererEvalAvailable({ nodeEnv: 'development', isPackaged: true })).toBe(false);
    expect(isRendererEvalAvailable({ rendererUrl: 'http://localhost:5273', isPackaged: true })).toBe(false);
    expect(isRendererEvalAvailable({ nodeEnv: 'development', rendererUrl: 'file:///x/index.html', isPackaged: true })).toBe(false);
  });

  it('is not offered without a development signal', () => {
    expect(isRendererEvalAvailable({ nodeEnv: 'production', isPackaged: false })).toBe(false);
    expect(isRendererEvalAvailable({ isPackaged: false })).toBe(false);
  });

  it('both the tool listing and the handler in extensionDevServer.ts use the gate with the packaged flag', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../extensionDevServer.ts'), 'utf8');
    const uses = src.match(/isRendererEvalAvailable\(\{[^}]*isPackaged: electronApp\.isPackaged/g) ?? [];
    expect(uses.length).toBe(2);
  });
});
