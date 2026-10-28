/**
 * The bootstrap block of a mission (F1 S4, design section 9), stored by the host
 * in `metadata.teamMissionContext` when it creates the root. It is the
 * coordinator's starting point: where the project's rules live, what the mission
 * is for, and the state of the front. It is only stored in F1; putting it in the
 * system prompt is F2.
 *
 * Built from what the host already knows, in priority order (the order is also
 * the order of the cut): project, mission, front state. The handoff, the active
 * pendings and the decisions of the front (design items 4-6) do not exist in F1
 * and are left out; nothing is read from disk but the existence of the policy
 * files. Each item is cut at its own cap with a visible marker saying how much
 * was cut and where to read the rest, and the whole block never exceeds
 * TEAM_MISSION_CONTEXT_MAX_CHARS.
 */

import * as fs from 'fs';
import * as path from 'path';

export const TEAM_MISSION_CONTEXT_MAX_CHARS = 6000;
/** Start of every cut marker: `[cortado: N caracteres; leia <where>]`. */
export const TEAM_MISSION_CUT_MARKER = '[cortado';

const PROJECT_ITEM_MAX_CHARS = 200;
const MISSION_ITEM_MAX_CHARS = 400;
const FRONT_STATE_ITEM_MAX_CHARS = 2000;
const FRONT_TITLE_MAX_CHARS = 120;

/** Project policy files whose existence the block reports; their content is never read. */
export const TEAM_MISSION_POLICY_FILES = ['CLAUDE.md', 'GOVERNANCA.md'] as const;

/** The policy files that exist at the workspace root. Existence only; a failing check counts as absent. */
export function detectPolicyFiles(
  workspacePath: string,
  exists: (file: string) => boolean = fs.existsSync,
): string[] {
  return TEAM_MISSION_POLICY_FILES.filter((name) => {
    try {
      return exists(path.join(workspacePath, name));
    } catch {
      return false;
    }
  });
}

export interface TeamMissionContextInput {
  workspaceName: string;
  policyFiles: readonly string[];
  goal: string;
  doneCriterion?: string;
  front: { id: string; title: string; status: string | null; description: string | null };
}

/**
 * Cut `text` at `max` characters; the marker says how much was cut and where to read it.
 * The marker is Portuguese from end to end (`[cortado: N caracteres; leia ...]`, as the design
 * and M-3 AC-5 name it), so `readHint` is Portuguese too.
 */
function capItem(text: string, max: number, readHint: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n${TEAM_MISSION_CUT_MARKER}: ${text.length - max} caracteres; leia ${readHint}]`;
}

function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').trim();
  return flat.length <= FRONT_TITLE_MAX_CHARS ? flat : `${flat.slice(0, FRONT_TITLE_MAX_CHARS)}…`;
}

export function buildTeamMissionContext(input: TeamMissionContextInput): string {
  const policy = input.policyFiles.length > 0
    ? `Local policy files: ${input.policyFiles.join(', ')}. Read them before planning.`
    : 'No local policy file found at the project root.';
  const project = capItem(`${input.workspaceName}. ${policy}`, PROJECT_ITEM_MAX_CHARS, 'a raiz do projeto');

  const mission = capItem(
    [`Goal: ${input.goal}`, ...(input.doneCriterion ? [`Done criterion: ${input.doneCriterion}`] : [])].join('\n'),
    MISSION_ITEM_MAX_CHARS,
    'os metadados da sessão',
  );

  const frontHeading = `${shortTitle(input.front.title)} (${input.front.id}${input.front.status ? `, ${input.front.status}` : ''})`;
  const frontState = input.front.description?.trim()
    ? capItem(input.front.description.trim(), FRONT_STATE_ITEM_MAX_CHARS, `${input.front.id} com tracker_get`)
    : '(the front has no recorded state)';

  const block = [
    '## Project',
    project,
    '',
    '## Mission',
    mission,
    '',
    `## Front: ${frontHeading}`,
    frontState,
  ].join('\n');

  if (block.length <= TEAM_MISSION_CONTEXT_MAX_CHARS) return block;
  // Safety net for the sum of the items: the cap is a hard limit.
  const cutTail = (cut: number) => `\n${TEAM_MISSION_CUT_MARKER}: ${cut} caracteres]`;
  let kept = TEAM_MISSION_CONTEXT_MAX_CHARS - cutTail(block.length).length;
  while (kept > 0 && kept + cutTail(block.length - kept).length > TEAM_MISSION_CONTEXT_MAX_CHARS) kept -= 1;
  return `${block.slice(0, kept)}${cutTail(block.length - kept)}`;
}
