// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../services/ecc/eccCatalogService', () => ({ eccCatalogLookupTool: vi.fn() }));

import { eccCatalogLookupTool } from '../../services/ecc/eccCatalogService';
import { META_AGENT_TOOL_DEFS, dispatchMetaAgentTool, setMetaAgentToolFns } from '../metaAgentServer';

/** Phase 1B: the catalog lookup over the host MCP server: passive data in, a tool error when the catalog is unusable. */
describe('ecc_catalog_lookup dispatch', () => {
  setMetaAgentToolFns({} as never);

  it('is declared read-only, with ids, query and limit only', () => {
    const def = META_AGENT_TOOL_DEFS.find((tool) => tool.name === 'ecc_catalog_lookup')!;
    expect(def).toBeDefined();
    expect(Object.keys((def.inputSchema as { properties: Record<string, unknown> }).properties).sort()).toEqual(['ids', 'limit', 'query']);
    expect((def.inputSchema as { required?: string[] }).required).toBeUndefined();
    expect(def.description).toMatch(/never runs, installs or authorizes anything/);
    expect(def.description).toMatch(/a requirement it lists is not a permission/);
  });

  it('passes the three arguments through and returns the answer as JSON', async () => {
    vi.mocked(eccCatalogLookupTool).mockResolvedValueOnce({
      catalog: { version: '2.2.3', sha: 'abc' }, matches: [], truncated: false, unknownIds: ['ecc:skill:nope'], note: 'Lookup only',
    });
    const text = await dispatchMetaAgentTool('mcp__nimbalyst-host__ecc_catalog_lookup', 'session-1', '/ws', { ids: ['skill:nope'], query: 'tdd', limit: 3 });
    expect(eccCatalogLookupTool).toHaveBeenCalledWith({ ids: ['skill:nope'], query: 'tdd', limit: 3 });
    expect(JSON.parse(text)).toMatchObject({ catalog: { version: '2.2.3' }, unknownIds: ['ecc:skill:nope'] });
  });

  it('a missing or corrupted catalog, or nothing to look up, is a tool error, never a silent answer', async () => {
    vi.mocked(eccCatalogLookupTool).mockResolvedValueOnce({ error: 'ECC catalog unavailable: ecc-2.2.3.json could not be read (ENOENT).' });
    await expect(dispatchMetaAgentTool('ecc_catalog_lookup', 'session-1', '/ws', { ids: ['skill:x'] })).rejects.toThrow(/ECC catalog unavailable/);
    vi.mocked(eccCatalogLookupTool).mockResolvedValueOnce({ error: 'ecc_catalog_lookup needs ids or a query.' });
    await expect(dispatchMetaAgentTool('ecc_catalog_lookup', 'session-1', '/ws', {})).rejects.toThrow(/needs ids or a query/);
  });
});
