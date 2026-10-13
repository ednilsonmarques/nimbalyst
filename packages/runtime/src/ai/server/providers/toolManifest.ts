/**
 * Tool Manifest v1: the deliverable of the `architect` team member (Phase 1A).
 *
 * A manifest is text: one ```yaml block in the architect's final message,
 * followed by a few short Markdown sections and a `Preparation:` line. The
 * final message travels to the coordinator in the ordinary [Child Session
 * Update], which keeps a final report whole up to 8,000 characters; hence the
 * 7,500-character ceiling here.
 *
 * This module extracts and validates a manifest for tests, tooling and the
 * later persistence step. It grants nothing. The manifest recommends tools,
 * MCP servers and ECC capabilities per role; the validator refuses any tool
 * recommended outside that role's own scope, so a manifest can never read as
 * a permission, and nothing else in the runtime reads `toolsAllowed` at all
 * (a test keeps it that way).
 */

import jsyaml from 'js-yaml';
import { TEAM_ROLES, type TeamRole } from './teamContext';
import { READ_SCOPE_ALLOWED_NATIVE_TOOLS, SDK_NATIVE_TOOLS, isToolDeniedForScope, type ChildToolScope } from './claudeCode/toolPolicy';
import { MCP_FIRST_PARTY_TOPOLOGY } from '../services/mcpTopology';
import { ECC_CATALOG_INDEX_CLASSES } from '../../ecc/eccCatalogIndex.generated';

export const TOOL_MANIFEST_VERSION = 1;
/** Fits the 8,000-character final-report cap of the [Child Session Update] with room for the status lines around it. */
export const TOOL_MANIFEST_MAX_CHARS = 7500;
export const TOOL_MANIFEST_MAX_LIST_ITEMS = 8;
export const TOOL_MANIFEST_MAX_QUESTIONS = 6;
export const TOOL_MANIFEST_ID = /^M-[1-9]\d*$/;
const MANIFEST_MARKER = /^[ \t]*toolManifest:[ \t]*1[ \t]*(?:#.*)?$/m;
const FENCE = /```(?:yaml|yml)[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;
const PREPARATION = /^Preparation:\s*(complete|partial)\b/m;

/**
 * Scope each role runs with (teamPolicy.ts for the roles, toolPolicy.ts for
 * what a scope allows). A manifest recommends within it and never beyond;
 * `other` has no role default, so it is checked as unrestricted.
 */
export const TOOL_MANIFEST_ROLE_SCOPES: Readonly<Record<TeamRole, ChildToolScope>> = Object.freeze({
  explorer: 'read',
  architect: 'read',
  reviewer: 'review',
  implementer: 'full',
  other: 'full',
});

const LIST_FIELDS = ['eccCapabilities', 'toolsForbidden', 'mcpRecommended', 'mcpForbidden', 'testsRequired', 'risks', 'doneCriteria', 'limitations', 'evidence'] as const;
const TEAM_PLANS = ['TEAM', 'SOLO'] as const;
const CONFIDENCES = ['high', 'medium', 'low'] as const;
const SEVERITIES = ['high', 'medium', 'low'] as const;
const SCOPES: readonly ChildToolScope[] = ['read', 'review', 'write', 'full'];
/** Narrowest first: a member planned with a narrower scope than its role default is judged by the narrower one. */
const SCOPE_ORDER: readonly ChildToolScope[] = ['read', 'review', 'write', 'full'];
const KNOWN_NATIVE_TOOLS: ReadonlySet<string> = new Set([...SDK_NATIVE_TOOLS, ...READ_SCOPE_ALLOWED_NATIVE_TOOLS, 'PowerShell']);

export interface ToolManifestScopeExcess {
  role: TeamRole;
  tool: string;
  scope: ChildToolScope;
}

export interface ToolManifestValidation {
  /** No errors: the manifest is well formed and recommends nothing beyond a role's scope. */
  ok: boolean;
  /** The parsed YAML object, null when no manifest block was found or it did not parse. */
  manifest: Record<string, unknown> | null;
  errors: string[];
  warnings: string[];
  /** Tools recommended to a role outside that role's scope; each is also an error. */
  exceedsScope: ToolManifestScopeExcess[];
  /** Length of the whole final message, the thing the 7,500 ceiling applies to. */
  chars: number;
  preparation: 'complete' | 'partial' | null;
}

/** The YAML inside the first fenced block that carries `toolManifest: 1`, or null. */
export function extractToolManifestYaml(text: string): string | null {
  for (const match of text.matchAll(FENCE)) {
    if (MANIFEST_MARKER.test(match[1])) return match[1];
  }
  return null;
}

/** Cheap check for a final message that is a manifest (the pilot report mirrors this marker). */
export function looksLikeToolManifest(text: string): boolean {
  return extractToolManifestYaml(text) !== null;
}

/**
 * The policy names a tool written in a manifest resolves to. A permission-rule
 * suffix (`Bash(npm test:*)`, `Read(src/**)`) narrows a tool's arguments; the
 * scope judges the tool itself, so the suffix is dropped first. An `mcp__` name
 * is itself; a server wildcard (`mcp__nimbalyst-host__*`) resolves to every
 * known first-party tool behind it, so the wildcard is judged by its worst
 * member. A bare name resolves to every first-party `mcp__<server>__` tool of
 * that name, and also to the native of that name when such a native exists
 * (`AskUserQuestion` is both a native and a first-party tool): the manifest is
 * judged against all of them, so a tool cannot slip through under the name the
 * policy happens not to check. A bare name nobody knows stays as written and
 * is judged as a native (fail-closed under read/review).
 */
export function resolveManifestToolNames(name: string): string[] {
  const base = name.replace(/\(.*\)\s*$/, '').trim();
  if (base.startsWith('mcp__')) {
    if (base.endsWith('*')) {
      const prefix = base.slice(0, -1);
      const serverKey = base.slice('mcp__'.length).split('__')[0];
      const server = MCP_FIRST_PARTY_TOPOLOGY.find((candidate) => candidate.configKey === serverKey);
      const covered = server
        ? (server.tools as readonly string[]).map((tool) => `mcp__${server.configKey}__${tool}`).filter((tool) => tool.startsWith(prefix))
        : [];
      return covered.length > 0 ? covered : [base];
    }
    return [base];
  }
  const names: string[] = [];
  for (const server of MCP_FIRST_PARTY_TOPOLOGY) {
    if ((server.tools as readonly string[]).includes(base)) names.push(`mcp__${server.configKey}__${base}`);
  }
  if (names.length === 0 || KNOWN_NATIVE_TOOLS.has(base)) names.push(base);
  return names;
}

/** The first policy name of a manifest tool name (see resolveManifestToolNames). */
export function normalizeManifestToolName(name: string): string {
  return resolveManifestToolNames(name)[0];
}

function narrowerScope(a: ChildToolScope, b: ChildToolScope): ChildToolScope {
  return SCOPE_ORDER.indexOf(a) <= SCOPE_ORDER.indexOf(b) ? a : b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isTeamRole(value: unknown): value is TeamRole {
  return typeof value === 'string' && (TEAM_ROLES as readonly string[]).includes(value);
}

/**
 * Validate the architect's final message. Pure; never throws on bad input.
 * `errors` make `ok` false; `warnings` are advice for the coordinator.
 */
export function parseToolManifest(text: string): ToolManifestValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const exceedsScope: ToolManifestScopeExcess[] = [];
  const chars = text.length;
  const preparationMatch = PREPARATION.exec(text);
  const preparation = preparationMatch ? (preparationMatch[1] as 'complete' | 'partial') : null;

  if (chars > TOOL_MANIFEST_MAX_CHARS) {
    errors.push(`the final message has ${chars} characters; a manifest message has at most ${TOOL_MANIFEST_MAX_CHARS} (the coordinator's update would arrive truncated)`);
  }
  const yamlText = extractToolManifestYaml(text);
  if (yamlText === null) {
    errors.push('no ```yaml block with `toolManifest: 1` was found');
    return { ok: false, manifest: null, errors, warnings, exceedsScope, chars, preparation };
  }
  let parsed: unknown;
  try {
    // js-yaml's `load` uses the default (safe) schema: no custom tags, no code.
    parsed = jsyaml.load(yamlText);
  } catch (error) {
    errors.push(`the manifest block is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, manifest: null, errors, warnings, exceedsScope, chars, preparation };
  }
  if (!isRecord(parsed)) {
    errors.push('the manifest block must be a YAML mapping');
    return { ok: false, manifest: null, errors, warnings, exceedsScope, chars, preparation };
  }
  const manifest = parsed;

  if (manifest.toolManifest !== TOOL_MANIFEST_VERSION) errors.push(`toolManifest must be ${TOOL_MANIFEST_VERSION}`);
  if (!nonEmptyString(manifest.id) || !TOOL_MANIFEST_ID.test(manifest.id)) errors.push('id must be M-<n> (M-1, M-2, ...)');
  for (const field of ['task', 'objective'] as const) {
    if (!nonEmptyString(manifest[field])) errors.push(`${field} is required`);
  }
  const oracle = manifest.oracle;
  if (!isRecord(oracle) || !nonEmptyString(oracle.sourceOfTruth)) {
    errors.push('oracle.sourceOfTruth is required (name the source of truth, or `open: <why>`)');
  } else if (!Array.isArray(oracle.evidenceRequired) || oracle.evidenceRequired.length === 0) {
    warnings.push('oracle.evidenceRequired is empty: say what the reviewer must see');
  }

  // Scope each role is judged by: the role default, narrowed by the scope the plan itself gives the member.
  const roleScopes: Record<TeamRole, ChildToolScope> = { ...TOOL_MANIFEST_ROLE_SCOPES };
  const teamPlan = manifest.teamPlan;
  if (!isRecord(teamPlan) || !(TEAM_PLANS as readonly unknown[]).includes(teamPlan.recommended)) {
    errors.push('teamPlan.recommended must be TEAM or SOLO');
  } else if (Array.isArray(teamPlan.members)) {
    if (teamPlan.members.length > TOOL_MANIFEST_MAX_LIST_ITEMS) errors.push(`teamPlan.members has more than ${TOOL_MANIFEST_MAX_LIST_ITEMS} items`);
    for (const member of teamPlan.members) {
      if (!isRecord(member) || !isTeamRole(member.role)) {
        errors.push(`teamPlan.members: each member needs a role among ${TEAM_ROLES.join(', ')}`);
        continue;
      }
      if (member.scope !== undefined && !(SCOPES as readonly unknown[]).includes(member.scope)) {
        errors.push(`teamPlan.members: ${member.role} has an unknown scope ${JSON.stringify(member.scope)}`);
      } else if (member.scope !== undefined) {
        roleScopes[member.role] = narrowerScope(roleScopes[member.role], member.scope as ChildToolScope);
      }
      if (member.role === 'reviewer' && member.scope !== undefined && member.scope !== 'review' && member.scope !== 'read') {
        errors.push('teamPlan.members: a reviewer never runs above the review scope');
      }
      if (member.role === 'architect' && member.scope !== undefined && member.scope !== 'read') {
        errors.push('teamPlan.members: an architect never runs above the read scope');
      }
    }
  }

  for (const field of LIST_FIELDS) {
    const value = manifest[field];
    if (value === undefined || value === null) continue;
    if (!Array.isArray(value)) errors.push(`${field} must be a list`);
    else if (value.length > TOOL_MANIFEST_MAX_LIST_ITEMS) errors.push(`${field} has ${value.length} items; at most ${TOOL_MANIFEST_MAX_LIST_ITEMS}`);
  }
  const questions = manifest.openQuestions;
  if (questions !== undefined && questions !== null) {
    if (!Array.isArray(questions)) errors.push('openQuestions must be a list');
    else if (questions.length > TOOL_MANIFEST_MAX_QUESTIONS) errors.push(`openQuestions has ${questions.length} items; at most ${TOOL_MANIFEST_MAX_QUESTIONS}`);
    else {
      for (const question of questions) {
        if (!isRecord(question) || !nonEmptyString(question.assumption)) {
          warnings.push('openQuestions: every question should carry the assumption the plan proceeds on');
          break;
        }
      }
    }
  }

  const capabilities = manifest.eccCapabilities;
  if (Array.isArray(capabilities)) {
    for (const capability of capabilities) {
      if (!isRecord(capability) || !nonEmptyString(capability.id)) {
        errors.push('eccCapabilities: each item needs an id');
        continue;
      }
      const indexed = Object.hasOwn(ECC_CATALOG_INDEX_CLASSES, capability.id) ? ECC_CATALOG_INDEX_CLASSES[capability.id] : undefined;
      if (!indexed) {
        errors.push(`eccCapabilities: ${capability.id} is not a citable catalog entry (not in the architect index)`);
        continue;
      }
      if (capability.class !== undefined && capability.class !== indexed) {
        warnings.push(`eccCapabilities: ${capability.id} is class ${indexed} in the index, not ${String(capability.class)}`);
      }
      if (capability.for !== undefined && !isTeamRole(capability.for)) {
        warnings.push(`eccCapabilities: ${capability.id} names an unknown role ${JSON.stringify(capability.for)}`);
      }
    }
  }

  const risks = manifest.risks;
  if (Array.isArray(risks)) {
    for (const risk of risks) {
      if (!isRecord(risk) || !(SEVERITIES as readonly unknown[]).includes(risk.severity)) {
        warnings.push('risks: every risk should carry a severity (high, medium or low)');
        break;
      }
    }
  }

  if (manifest.confidence !== undefined && !(CONFIDENCES as readonly unknown[]).includes(manifest.confidence)) {
    errors.push('confidence must be high, medium or low');
  }

  const toolsAllowed = manifest.toolsAllowed;
  if (toolsAllowed !== undefined && toolsAllowed !== null) {
    if (!isRecord(toolsAllowed)) {
      errors.push('toolsAllowed must map a role to a list of tool names');
    } else {
      for (const [roleName, tools] of Object.entries(toolsAllowed)) {
        if (!isTeamRole(roleName)) {
          errors.push(`toolsAllowed: ${roleName} is not a team role`);
          continue;
        }
        if (!Array.isArray(tools)) {
          errors.push(`toolsAllowed.${roleName} must be a list`);
          continue;
        }
        const scope = roleScopes[roleName];
        for (const raw of tools) {
          if (!nonEmptyString(raw)) {
            errors.push(`toolsAllowed.${roleName} holds an item that is not a tool name`);
            continue;
          }
          const written = raw.trim();
          if (resolveManifestToolNames(written).some((tool) => isToolDeniedForScope(scope, tool, [], roleName))) {
            exceedsScope.push({ role: roleName, tool: written, scope });
          }
        }
      }
    }
  }
  for (const excess of exceedsScope) {
    errors.push(`toolsAllowed.${excess.role} lists ${excess.tool}, outside the ${excess.scope} scope that role runs with; a manifest cannot widen a scope`);
  }

  const mcpRecommended = manifest.mcpRecommended;
  if (Array.isArray(mcpRecommended)) {
    for (const entry of mcpRecommended) {
      if (!isRecord(entry) || !nonEmptyString(entry.server)) {
        errors.push('mcpRecommended: each item needs a server name');
        continue;
      }
      if (MCP_FIRST_PARTY_TOPOLOGY.some((server) => server.configKey === entry.server)) {
        // Nimbalyst's own servers are already there for every member within its scope: nothing to recommend or authorize.
        warnings.push(`mcpRecommended: ${entry.server} is Nimbalyst's own server, already available to every member within its scope; list external servers only`);
      } else if (entry.scope === 'read' || entry.scope === 'review') {
        errors.push(`mcpRecommended: ${entry.server} cannot serve a ${String(entry.scope)} member; read and review see no server beyond Nimbalyst's own`);
      } else if (entry.scope !== undefined && !(SCOPES as readonly unknown[]).includes(entry.scope)) {
        errors.push(`mcpRecommended: ${entry.server} has an unknown scope ${JSON.stringify(entry.scope)}`);
      }
      if (entry.authorizationRequired !== undefined && typeof entry.authorizationRequired !== 'boolean') {
        warnings.push(`mcpRecommended: ${entry.server} should say whether authorization is required (true or false)`);
      }
    }
  }

  const generatedBy = manifest.generatedBy;
  if (!isRecord(generatedBy) || generatedBy.role !== 'architect') {
    warnings.push('generatedBy.role should be architect');
  }
  if (preparation === null) warnings.push('the message does not end with `Preparation: complete` or `Preparation: partial (<reason>)`');

  return { ok: errors.length === 0, manifest, errors, warnings, exceedsScope, chars, preparation };
}
