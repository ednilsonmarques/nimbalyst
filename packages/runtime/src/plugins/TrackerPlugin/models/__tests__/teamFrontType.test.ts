// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import { globalRegistry, isTerminalStatus, statusCategoryOfItem } from '@nimbalyst/tracker-schema';
import { TEAM_FRONT_DESCRIPTION_MAX_CHARS, TEAM_FRONT_STATUSES, isProtectedTrackerType } from '@nimbalyst/tracker-core';
import { BUILTIN_TRACKER_YAML, loadBuiltinTrackers } from '../ModelLoader';
import teamNoteYaml from '../builtins/team-note.yaml?raw';
import teamFrontYaml from '../builtins/team-front.yaml?raw';

beforeAll(() => {
  loadBuiltinTrackers();
});

describe('team-front tracker type', () => {
  it('is a builtin, registered as a team-shared type with the same sharing as team-note', () => {
    expect(BUILTIN_TRACKER_YAML.some((entry) => entry.type === 'team-front')).toBe(true);
    expect(globalRegistry.isBuiltin('team-front')).toBe(true);
    const model = globalRegistry.get('team-front')!;
    const note = globalRegistry.get('team-note')!;
    expect(model.sharing).toBe('team');
    expect(model.sharing).toBe(note.sharing);
    expect(model.draftByDefault).toBe(note.draftByDefault);
    // The yaml carries the same sharing lines as team-note's, not just the same resolved value.
    const sharingLines = (yaml: string) => yaml.split(/\r?\n/).filter((line) => /^(sharing|draftByDefault):/.test(line));
    expect(sharingLines(teamFrontYaml)).toEqual(sharingLines(teamNoteYaml));
  });

  it('is creatable (the user makes fronts) and is a protected type', () => {
    expect(globalRegistry.get('team-front')!.creatable).not.toBe(false);
    expect(isProtectedTrackerType('team-front')).toBe(true);
  });

  it('has the three statuses of the core rule, in the same order, and active is the default', () => {
    const status = globalRegistry.get('team-front')!.fields.find((f) => f.name === 'status')!;
    expect(status.options?.map((o: any) => o.value)).toEqual([...TEAM_FRONT_STATUSES]);
    expect(status.default).toBe('active');
  });

  it('active and paused are open; closed is terminal, so the default listing hides it', () => {
    const category = (value: string) => statusCategoryOfItem('team-front', (name) => (name === 'status' ? value : undefined));
    expect(category('closed')).toBe('done');
    expect(isTerminalStatus('team-front', 'active')).toBe(false);
    expect(isTerminalStatus('team-front', 'paused')).toBe(false);
    expect(isTerminalStatus('team-front', 'closed')).toBe(true);
  });

  it('declares a required title and a description capped at the core rule', () => {
    const fields = globalRegistry.get('team-front')!.fields;
    expect(fields.find((f) => f.name === 'title')?.required).toBe(true);
    const description = fields.find((f) => f.name === 'description')!;
    expect(description.maxLength).toBe(TEAM_FRONT_DESCRIPTION_MAX_CHARS);
  });

  it('declares currentMission read-only, so nothing but the host fills it', () => {
    const fields = globalRegistry.get('team-front')!.fields;
    expect(fields.find((f) => f.name === 'currentMission')?.readOnly).toBe(true);
    expect(fields.find((f) => f.name === 'created')?.readOnly).toBe(true);
    expect(fields.find((f) => f.name === 'updated')?.readOnly).toBe(true);
  });

  it('keeps the standard roles', () => {
    const model = globalRegistry.get('team-front')!;
    expect(model.roles?.title).toBe('title');
    expect(model.roles?.workflowStatus).toBe('status');
    expect(model.idPrefix).toBe('tfr');
  });

  it('does not carry the team-note lifecycle fields (S2 put them on team-note): no front, nextAction or handoff structure here', () => {
    const names = globalRegistry.get('team-front')!.fields.map((f) => f.name);
    for (const name of ['front', 'nextAction', 'result', 'commits', 'pendings', 'relatedNotes']) expect(names, name).not.toContain(name);
    // They are on team-note now.
    const noteNames = globalRegistry.get('team-note')!.fields.map((f) => f.name);
    for (const name of ['front', 'nextAction', 'result', 'commits', 'pendings', 'relatedNotes']) expect(noteNames, name).toContain(name);
  });
});
