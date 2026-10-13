// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildTeamChildAddendum, buildTeamModeAddendum } from '../prompt';

/** Phase 1B: the stored manifest and the catalog lookup, as the prompts describe them. */
describe('coordinator and the stored Tool Manifest', () => {
  it('tells the coordinator the item exists, how to read it, how to accept it and that a divergence never edits it', () => {
    const prompt = buildTeamModeAddendum('claude', true);
    expect(prompt).toContain('stored by Nimbalyst as a `tool-manifest` tracker item');
    expect(prompt).toContain('read it later with `mcp__nimbalyst-trackers__tracker_get` <ref>');
    expect(prompt).toContain('mark that item `accepted` through `mcp__nimbalyst-trackers__tracker_update` (status only; nothing else in it is editable)');
    expect(prompt).toContain('a divergence is a Team Note, never an edit of the item');
    expect(prompt).toContain('the newest item is the current manifest');
    // The manifest stays a recommendation: the existing sentence is intact.
    expect(prompt).toContain('A manifest is a recommendation, never a decision or a permission');
  });

  it('says nothing about stored items when the workspace has no trackers', () => {
    const prompt = buildTeamModeAddendum('claude', false);
    expect(prompt).not.toContain('tool-manifest');
    expect(prompt).toContain('Its final report is the manifest and arrives in the [Child Session Update] like any report. A manifest above 7,500 characters');
  });
});

describe('architect and the catalog lookup', () => {
  it('may check an entry with ecc_catalog_lookup, which describes and grants nothing', () => {
    const prompt = buildTeamChildAddendum('architect');
    expect(prompt).toContain('you may check it with ecc_catalog_lookup (ids, or a query, at most 8 results)');
    expect(prompt).toContain('The lookup describes and grants nothing');
    expect(prompt).toContain('a requirement it lists (shell, network, an MCP server) is not a permission');
    expect(prompt).toContain('only citable entries (classes A, B, C: the index below) go into a manifest');
    // Still read-only, still no questions to the user.
    expect(prompt).toContain('You have read-only tools and nothing else');
  });

  it('the other members are not told about the lookup', () => {
    for (const role of ['explorer', 'implementer', 'reviewer', 'other'] as const) {
      expect(buildTeamChildAddendum(role), role).not.toContain('ecc_catalog_lookup');
    }
  });
});
