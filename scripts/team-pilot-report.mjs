#!/usr/bin/env node
/**
 * Local report of how Team mode is being used, derived from the app's own
 * SQLite database. Read-only, nothing is stored and nothing leaves the
 * machine.
 *
 *   node scripts/team-pilot-report.mjs                 # the default app profile
 *   node scripts/team-pilot-report.mjs --user-data "%APPDATA%/@nimbalyst/electron-team-test"
 *   node scripts/team-pilot-report.mjs --db path/to/nimbalyst.sqlite --since 2026-10-10 --json
 *
 * Privacy: the report carries counts, roles, models, effort levels, tool
 * names, timestamps and shortened session ids. It never carries prompts,
 * transcript text, code, Team Note contents, file names, commands or command
 * output. Message bodies are scanned for a fixed set of markers only.
 *
 * A metric that cannot be derived is reported as unavailable (null in JSON),
 * never as zero.
 */

import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { teamProviderDiversity } from '../packages/runtime/src/ai/server/providers/teamProviderDiversity.mjs';
import { REVIEW_VERDICT_PATTERN, ADVISOR_OPINION_PATTERN } from '../packages/runtime/src/ai/server/providers/teamReportMarkers.mjs';

const MEMBER_ROLES = ['explorer', 'implementer', 'reviewer', 'architect', 'advisor', 'other'];
// Role defaults (teamPolicy.ts): Sonnet/medium, reviewer high, architect Opus/high, advisor OpenAI Codex gpt-6.1-sol/high.
const defaultModelFor = (role) => (role === 'architect' ? 'claude-code:opus' : role === 'advisor' ? 'openai-codex:gpt-6.1-sol' : 'claude-code:sonnet');
const defaultEffortFor = (role) => (role === 'reviewer' || role === 'architect' || role === 'advisor' ? 'high' : 'medium');

// Tools worth counting by name. Everything else is ignored, not listed.
const COUNTED_TOOLS = ['Agent', 'Task', 'create_session', 'spawn_session', 'get_session_result', 'run_project_tests', 'send_prompt'];

const TOOL_USE = /"type":"tool_use","id":"[^"]+","name":"([^"]+)"/g;
// Both markers must OPEN a tool result. The same words inside a file a session
// read (this repository's own sources, for one) are not an event.
const RESULT_START = '"(?:content|text)":"(?:<tool_use_error>)?(?:Error: )?';
// The CLI's reply when a tool a scope removed is called anyway.
const SCOPE_DENIED = new RegExp(`${RESULT_START}No such tool available: `, 'g');
// Refusals of teamSpawnRefusal (teamPolicy.ts).
const LIMIT_REFUSAL = new RegExp(
  `${RESULT_START}Team (?:limit: [0-9]+/[0-9]+ sessions are already active|budget reached: this team|depth limit reached: this session)`,
  'g',
);
const DECLARED_PLAN = /Team plan:[\s*]*(SOLO|TEAM)/;
const REVIEW_VERDICT = new RegExp(REVIEW_VERDICT_PATTERN, 'g');
// (ADVISOR_OPINION is defined below TEXT_BLOCK: it is anchored to a text block.)
// The architect's deliverable (toolManifest.ts) and what the coordinator said
// about it. Both are read inside a text content block (`"type":"text","text":
// "..."`) of an assistant message only: a draft in a thinking block, a brief
// inside a tool_use input (create_session, tracker_create), a tool input that
// happens to carry a `text` key (voice_agent_speak) or a quoted user message
// never counts. A JSON string value runs until its first unescaped quote.
const TEXT_BLOCK = '"type":"text","text":"(?:[^"\\\\]|\\\\.)*?';
const TOOL_MANIFEST = new RegExp(`${TEXT_BLOCK}toolManifest:\\s*1\\b`);
const MANIFEST_DECISION = new RegExp(`${TEXT_BLOCK}Team plan:(?:[^"\\\\]|\\\\.)*?\\b(per manifest|diverging from) M-\\d+\\b`);
// The advisor's opinion line (prompt.ts, buildAdvisorAddendum), counted like a
// review verdict but only inside an assistant text block: a draft in a thinking
// block or a quoted line inside a tool input never counts.
const ADVISOR_OPINION = new RegExp(`${TEXT_BLOCK}${ADVISOR_OPINION_PATTERN}`, 'g');

function shortToolName(name) {
  const parts = name.split('__');
  return parts[parts.length - 1];
}

/**
 * Facts of one stored message. Only markers and tool names are read; the text
 * itself is never returned.
 */
export function extractMessageFacts(content) {
  const text = typeof content === 'string' ? content : '';
  const tools = {};
  for (const match of text.matchAll(TOOL_USE)) {
    const name = shortToolName(match[1]);
    if (COUNTED_TOOLS.includes(name)) tools[name] = (tools[name] ?? 0) + 1;
  }
  const isAssistant = text.includes('"role":"assistant"');
  const plan = isAssistant ? text.match(DECLARED_PLAN)?.[1] ?? null : null;
  const decision = isAssistant ? text.match(MANIFEST_DECISION)?.[1] ?? null : null;
  return {
    tools,
    scopeDenied: (text.match(SCOPE_DENIED) ?? []).length,
    limitRefusals: (text.match(LIMIT_REFUSAL) ?? []).length,
    verdicts: isAssistant ? (text.match(REVIEW_VERDICT) ?? []).length : 0,
    opinions: isAssistant ? (text.match(ADVISOR_OPINION) ?? []).length : 0,
    declaredPlan: plan,
    manifests: isAssistant && TOOL_MANIFEST.test(text) ? 1 : 0,
    manifestDecision: decision === 'per manifest' ? 'accepted' : decision === 'diverging from' ? 'diverged' : null,
  };
}

function parseMetadata(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw ?? '{}') ?? {};
  } catch {
    return {};
  }
}

function toMillis(value) {
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isNaN(parsed) ? null : parsed;
}

const emptyRoleCounts = () => Object.fromEntries(MEMBER_ROLES.map((role) => [role, 0]));
const addInto = (target, source) => {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
};

/**
 * Aggregate the pilot.
 *
 * @param {object} input
 * @param {Array<{id, createdBySessionId, model, status, metadata, createdAt, updatedAt}>} input.sessions
 * @param {Array<{sessionId, createdAt, content}>|null} input.messages  null when messages could not be read
 * @param {Array<{metadata?: object, data?: object}>|null} input.teamNotes  null when notes could not be read
 * @param {number|null} [input.since]  only roots created at or after this instant (ms)
 */
export function summarizeTeamPilot({ sessions, messages, teamNotes, toolManifests = null, since = null }) {
  const rows = sessions.map((session) => ({ ...session, metadata: parseMetadata(session.metadata) }));
  const childrenOf = new Map();
  for (const row of rows) {
    if (!row.createdBySessionId || row.createdBySessionId === row.id) continue;
    if (!childrenOf.has(row.createdBySessionId)) childrenOf.set(row.createdBySessionId, []);
    childrenOf.get(row.createdBySessionId).push(row);
  }
  const membersOf = (rootId) => {
    const members = [];
    const seen = new Set([rootId]);
    const visit = (id) => {
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        members.push(child);
        visit(child.id);
      }
    };
    visit(rootId);
    return members;
  };

  // Normal sessions are out by default: only Team mode roots and what they created.
  const roots = rows
    .filter((row) => row.metadata.teamMode === true)
    .filter((row) => since === null || (toMillis(row.createdAt) ?? 0) >= since)
    .sort((a, b) => (toMillis(a.createdAt) ?? 0) - (toMillis(b.createdAt) ?? 0));

  const factsBySession = messages === null ? null : new Map();
  if (factsBySession) {
    for (const message of messages) {
      const facts = extractMessageFacts(message.content);
      let entry = factsBySession.get(message.sessionId);
      if (!entry) {
        entry = { tools: {}, scopeDenied: 0, limitRefusals: 0, verdicts: 0, opinions: 0, declaredPlans: [], manifests: 0, manifestDecisions: [], first: null, last: null };
        factsBySession.set(message.sessionId, entry);
      }
      addInto(entry.tools, facts.tools);
      entry.scopeDenied += facts.scopeDenied;
      entry.limitRefusals += facts.limitRefusals;
      entry.verdicts += facts.verdicts;
      entry.opinions += facts.opinions;
      entry.manifests += facts.manifests;
      if (facts.declaredPlan) entry.declaredPlans.push(facts.declaredPlan);
      if (facts.manifestDecision) entry.manifestDecisions.push(facts.manifestDecision);
      const at = toMillis(message.createdAt);
      if (at !== null) {
        entry.first = entry.first === null ? at : Math.min(entry.first, at);
        entry.last = entry.last === null ? at : Math.max(entry.last, at);
      }
    }
  }
  const factsOf = (id) => factsBySession?.get(id) ?? null;

  const notesByRoot = teamNotes === null ? null : new Map();
  if (notesByRoot) {
    for (const note of teamNotes) {
      const data = parseMetadata(note.data);
      const fields = data.customFields && typeof data.customFields === 'object' ? data.customFields : data;
      const rootId = fields.teamRootSession;
      if (typeof rootId === 'string') notesByRoot.set(rootId, (notesByRoot.get(rootId) ?? 0) + 1);
    }
  }

  // Phase 1B: stored manifests per team root (teamRootSessionId is host-written provenance).
  const manifestsByRoot = toolManifests === null ? null : new Map();
  if (manifestsByRoot) {
    for (const item of toolManifests) {
      const data = parseMetadata(item.data);
      const fields = data.customFields && typeof data.customFields === 'object' ? { ...data, ...data.customFields } : data;
      const rootId = fields.teamRootSessionId;
      if (typeof rootId !== 'string') continue;
      const list = manifestsByRoot.get(rootId) ?? [];
      list.push({
        ref: item.localKey ?? item.id,
        manifestId: typeof fields.manifestId === 'string' ? fields.manifestId : null,
        declaredManifestId: typeof fields.declaredManifestId === 'string' ? fields.declaredManifestId : null,
        status: typeof fields.status === 'string' ? fields.status : null,
        architect: typeof fields.architectSessionId === 'string' ? fields.architectSessionId : null,
        confidence: typeof fields.confidence === 'string' ? fields.confidence : null,
      });
      manifestsByRoot.set(rootId, list);
    }
  }

  const teams = roots.map((root) => {
    const members = membersOf(root.id);
    const roles = emptyRoleCounts();
    const promotions = [];
    // Every advisor (Consultor Independente) with where it ran and whether its
    // provider differs from the root's (teamProviderDiversity in teamPolicy.ts):
    // a same-provider advisor is an independent opinion, not a provider-diverse
    // one, and the report must not suggest otherwise. The mission text itself
    // is never carried (it is coordinator-written text), only whether one exists.
    const advisors = [];
    for (const member of members) {
      const role = MEMBER_ROLES.includes(member.metadata.teamChild?.role) ? member.metadata.teamChild.role : 'other';
      roles[role] += 1;
      const effort = member.metadata.effortLevel ?? null;
      const modelPromoted = !!member.model && member.model !== defaultModelFor(role);
      const effortPromoted = !!effort && effort !== defaultEffortFor(role);
      if (modelPromoted || effortPromoted) {
        promotions.push({ role, model: member.model ?? null, effort, modelPromoted, effortPromoted });
      }
      if (role === 'advisor') {
        const provider = member.provider ?? null;
        advisors.push({
          id: String(member.id).slice(0, 8),
          provider,
          model: member.model ?? null,
          effort,
          scope: member.metadata.toolScope ?? null,
          hasMission: typeof member.metadata.teamChild?.mission === 'string' && member.metadata.teamChild.mission.length > 0,
          providerDiversity: teamProviderDiversity(provider, root.provider),
        });
      }
    }

    const all = [root, ...members];
    let tools = null;
    let scopeDenied = null;
    let limitRefusals = null;
    let reviewCycles = null;
    let declaredPlans = null;
    let durationMinutes = null;
    let manifests = null;
    let advisorOpinions = null;
    let manifestDecisions = null;
    if (factsBySession) {
      tools = Object.fromEntries(COUNTED_TOOLS.map((name) => [name, 0]));
      scopeDenied = 0;
      limitRefusals = 0;
      reviewCycles = 0;
      manifests = 0;
      advisorOpinions = 0;
      let first = null;
      let last = null;
      for (const session of all) {
        const facts = factsOf(session.id);
        if (!facts) continue;
        addInto(tools, facts.tools);
        limitRefusals += facts.limitRefusals;
        // Only members can be scope-restricted; the root has full tools.
        if (session !== root) scopeDenied += facts.scopeDenied;
        if (session.metadata.teamChild?.role === 'reviewer') reviewCycles += facts.verdicts;
        // Only the advisor's own opinion lines count (a coordinator quoting one does not).
        if (session.metadata.teamChild?.role === 'advisor') advisorOpinions += facts.opinions;
        // Only the architect's own reports count as manifests (a coordinator quoting one does not).
        if (session.metadata.teamChild?.role === 'architect') manifests += facts.manifests;
        if (facts.first !== null) first = first === null ? facts.first : Math.min(first, facts.first);
        if (facts.last !== null) last = last === null ? facts.last : Math.max(last, facts.last);
      }
      declaredPlans = factsOf(root.id)?.declaredPlans ?? [];
      manifestDecisions = factsOf(root.id)?.manifestDecisions ?? [];
      durationMinutes = first !== null && last !== null ? Math.round((last - first) / 6000) / 10 : null;
    }

    return {
      id: String(root.id).slice(0, 8),
      createdAt: root.createdAt ?? null,
      provider: root.provider ?? null,
      model: root.model ?? null,
      effort: root.metadata.effortLevel ?? null,
      kind: members.length === 0 ? 'solo' : 'team',
      members: members.length,
      roles,
      reviewers: roles.reviewer,
      reviewCycles,
      architects: roles.architect,
      manifests,
      advisors: roles.advisor,
      advisorOpinions,
      advisorSessions: advisors,
      advisorsProviderDiverse: advisors.filter((advisor) => advisor.providerDiversity === 'diverse').length,
      manifestDecisions,
      declaredPlans,
      tools,
      scopeDenied,
      limitRefusals,
      promotions,
      teamNotes: notesByRoot ? notesByRoot.get(root.id) ?? 0 : null,
      storedManifests: manifestsByRoot ? manifestsByRoot.get(root.id) ?? [] : null,
      errors: all.filter((session) => session.status === 'error').length,
      durationMinutes,
    };
  });

  const sum = (pick) => (teams.some((team) => pick(team) === null) ? null : teams.reduce((total, team) => total + pick(team), 0));
  const roleTotals = emptyRoleCounts();
  for (const team of teams) addInto(roleTotals, team.roles);
  const toolTotals = factsBySession
    ? Object.fromEntries(COUNTED_TOOLS.map((name) => [name, teams.reduce((total, team) => total + (team.tools?.[name] ?? 0), 0)]))
    : null;

  return {
    generatedFor: { since: since === null ? null : new Date(since).toISOString() },
    totals: {
      teamRoots: teams.length,
      solo: teams.filter((team) => team.kind === 'solo').length,
      team: teams.filter((team) => team.kind === 'team').length,
      members: teams.reduce((total, team) => total + team.members, 0),
      membersByRole: roleTotals,
      reviewers: roleTotals.reviewer,
      reviewCycles: sum((team) => team.reviewCycles),
      architects: roleTotals.architect,
      advisors: roleTotals.advisor,
      advisorOpinions: sum((team) => team.advisorOpinions),
      advisorsProviderDiverse: teams.reduce((total, team) => total + team.advisorsProviderDiverse, 0),
      manifests: sum((team) => team.manifests),
      manifestDivergences: sum((team) => (team.manifestDecisions === null ? null : team.manifestDecisions.filter((d) => d === 'diverged').length)),
      tools: toolTotals,
      scopeDeniedAttempts: sum((team) => team.scopeDenied),
      limitRefusals: sum((team) => team.limitRefusals),
      promotions: teams.reduce((total, team) => total + team.promotions.length, 0),
      teamNotes: teamNotes === null ? null : teamNotes.length,
      teamNotesByTeams: sum((team) => team.teamNotes),
      storedManifests: toolManifests === null ? null : toolManifests.length,
      storedManifestsByTeams: sum((team) => (team.storedManifests === null ? null : team.storedManifests.length)),
      errors: teams.reduce((total, team) => total + team.errors, 0),
    },
    teams,
    notes: [
      'Tool counts come from stored tool calls; only the names listed are counted.',
      'scopeDeniedAttempts counts "No such tool available" replies in member sessions; an approximation.',
      'reviewCycles counts reviewer reports that open with a verdict.',
      'advisorOpinions counts advisor (Consultor Independente) reports that open with an independent opinion.',
      'advisorsProviderDiverse counts advisors whose provider differs from their root\'s; a same-provider advisor is an independent opinion, not a provider-diverse one.',
      'manifests counts architect reports that carry a Tool Manifest block; manifestDivergences counts coordinator turns that diverge from a manifest.',
      'durationMinutes is the span between the first and last stored message of the team, idle time included.',
      'errors counts sessions currently in the error state; past, recovered errors are not counted.',
    ],
  };
}

const show = (value) => (value === null || value === undefined ? 'indisponível' : String(value));

export function renderMarkdown(report) {
  const { totals, teams } = report;
  const lines = ['# Team mode: relatório local do piloto', ''];
  if (report.generatedFor.since) lines.push(`Raízes criadas a partir de ${report.generatedFor.since}.`, '');
  lines.push('## Totais', '', '| Métrica | Valor |', '|---|---|');
  const row = (label, value) => lines.push(`| ${label} | ${show(value)} |`);
  row('Raízes de Team mode', totals.teamRoots);
  row('SOLO', totals.solo);
  row('TEAM', totals.team);
  row('Membros', totals.members);
  for (const role of MEMBER_ROLES) row(`Membros ${role}`, totals.membersByRole[role]);
  row('Ciclos de revisão', totals.reviewCycles);
  row('Manifestos do Architect', totals.manifests);
  row('Pareceres do Consultor Independente', totals.advisorOpinions);
  row('Consultores Independentes em provider diferente da raiz', totals.advisorsProviderDiverse);
  row('Divergências do Coordenador sobre manifestos', totals.manifestDivergences);
  for (const name of COUNTED_TOOLS) row(`Chamadas ${name}`, totals.tools ? totals.tools[name] : null);
  row('Tentativas bloqueadas por escopo (aprox.)', totals.scopeDeniedAttempts);
  row('Recusas por limite', totals.limitRefusals);
  row('Promoções de modelo/esforço', totals.promotions);
  row('Team Notes (total no banco)', totals.teamNotes);
  row('Team Notes atribuídas a estas raízes', totals.teamNotesByTeams);
  row('Tool Manifests gravados (total no banco)', totals.storedManifests);
  row('Tool Manifests gravados para estas raízes', totals.storedManifestsByTeams);
  row('Sessões em erro', totals.errors);
  lines.push('', '## Por raiz', '');
  lines.push('| Raiz | Criada | Modelo/esforço | Tipo | Membros (E/I/R/A/C/O) | Revisões | Manifestos | Pareceres | Agent | create | spawn | get_result | run_tests | Bloqueios | Recusas | Promoções | Notas | Erros | Duração (min) |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const team of teams) {
    const tool = (name) => show(team.tools ? team.tools[name] : null);
    const agentCalls = team.tools ? team.tools.Agent + team.tools.Task : null;
    lines.push(
      `| ${team.id} | ${show(team.createdAt)} | ${show(team.model)}/${show(team.effort)} | ${team.kind.toUpperCase()} | ` +
      `${team.members} (${team.roles.explorer}/${team.roles.implementer}/${team.roles.reviewer}/${team.roles.architect}/${team.roles.advisor}/${team.roles.other}) | ` +
      `${show(team.reviewCycles)} | ${show(team.manifests)} | ${show(team.advisorOpinions)} | ${show(agentCalls)} | ${tool('create_session')} | ${tool('spawn_session')} | ` +
      `${tool('get_session_result')} | ${tool('run_project_tests')} | ${show(team.scopeDenied)} | ${show(team.limitRefusals)} | ` +
      `${team.promotions.length} | ${show(team.teamNotes)} | ${team.errors} | ${show(team.durationMinutes)} |`,
    );
  }
  const storedManifests = teams.flatMap((team) => (team.storedManifests ?? []).map((manifest) => ({ team: team.id, ...manifest })));
  if (storedManifests.length > 0) {
    lines.push('', '## Tool Manifests gravados', '', '| Raiz | Ref | Id | Declarado | Status | Architect | Confiança |', '|---|---|---|---|---|---|---|');
    for (const manifest of storedManifests) {
      lines.push(`| ${manifest.team} | ${manifest.ref} | ${show(manifest.manifestId)} | ${show(manifest.declaredManifestId)} | ${show(manifest.status)} | ${show(manifest.architect)} | ${show(manifest.confidence)} |`);
    }
  }
  const advisors = teams.flatMap((team) => team.advisorSessions.map((advisor) => ({ team: team.id, rootProvider: team.provider, ...advisor })));
  if (advisors.length > 0) {
    lines.push('', '## Consultores Independentes', '', '| Raiz | Sessão | Provider | Provider da raiz | Modelo | Esforço | Escopo | Missão | Diversidade de provider |', '|---|---|---|---|---|---|---|---|---|');
    for (const advisor of advisors) {
      const diversity = advisor.providerDiversity === 'diverse' ? 'sim (provider diferente)' : advisor.providerDiversity === 'same' ? 'não (mesmo provider da raiz)' : 'indisponível';
      lines.push(`| ${advisor.team} | ${advisor.id} | ${show(advisor.provider)} | ${show(advisor.rootProvider)} | ${show(advisor.model)} | ${show(advisor.effort)} | ${show(advisor.scope)} | ${advisor.hasMission ? 'sim' : 'não'} | ${diversity} |`);
    }
  }
  const promoted = teams.flatMap((team) => team.promotions.map((promotion) => ({ team: team.id, ...promotion })));
  if (promoted.length > 0) {
    lines.push('', '## Promoções', '', '| Raiz | Papel | Modelo | Esforço |', '|---|---|---|---|');
    for (const promotion of promoted) {
      lines.push(`| ${promotion.team} | ${promotion.role} | ${show(promotion.model)}${promotion.modelPromoted ? ' *' : ''} | ${show(promotion.effort)}${promotion.effortPromoted ? ' *' : ''} |`);
    }
    lines.push('', '\\* fora do padrão do papel.');
  }
  lines.push('', '## Notas de leitura', '');
  for (const note of report.notes) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { json: false, db: null, userData: null, since: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--db') args.db = argv[++index];
    else if (arg === '--user-data') args.userData = argv[++index];
    else if (arg === '--since') args.since = argv[++index];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function defaultUserData() {
  if (process.platform === 'win32') return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '@nimbalyst', 'electron');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', '@nimbalyst', 'electron');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), '@nimbalyst', 'electron');
}

/** Read the three inputs from a database opened read-only. A table that cannot be read yields null. */
export async function readPilotData(dbPath) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const sessions = db.prepare(
      `SELECT id, created_by_session_id AS createdBySessionId, provider, model, status, metadata,
              created_at AS createdAt, updated_at AS updatedAt
       FROM ai_sessions`,
    ).all();

    // Only team sessions' messages are read: Team mode roots and everything they created.
    const teamIds = new Set();
    const byCreator = new Map();
    for (const session of sessions) {
      if (!session.createdBySessionId) continue;
      if (!byCreator.has(session.createdBySessionId)) byCreator.set(session.createdBySessionId, []);
      byCreator.get(session.createdBySessionId).push(session.id);
    }
    const visit = (id) => {
      if (teamIds.has(id)) return;
      teamIds.add(id);
      for (const child of byCreator.get(id) ?? []) visit(child);
    };
    for (const session of sessions) {
      if (parseMetadata(session.metadata).teamMode === true) visit(session.id);
    }

    let messages = null;
    try {
      const statement = db.prepare('SELECT session_id AS sessionId, created_at AS createdAt, content FROM ai_agent_messages WHERE session_id = ?');
      messages = [];
      for (const id of teamIds) messages.push(...statement.all(id));
    } catch {
      messages = null;
    }

    let teamNotes = null;
    try {
      teamNotes = db.prepare("SELECT data FROM tracker_items WHERE type = 'team-note'").all();
    } catch {
      teamNotes = null;
    }
    // Phase 1B: the architects' manifests stored as tracker items.
    let toolManifests = null;
    try {
      toolManifests = db.prepare("SELECT id, local_key AS localKey, data FROM tracker_items WHERE type = 'tool-manifest' ORDER BY created").all();
    } catch {
      toolManifests = null;
    }
    return { sessions, messages, teamNotes, toolManifests };
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/team-pilot-report.mjs [--user-data <dir> | --db <file>] [--since <date>] [--json]');
    return;
  }
  const dbPath = args.db ?? path.join(args.userData ?? defaultUserData(), 'sqlite-db', 'nimbalyst.sqlite');
  const since = args.since ? Date.parse(args.since) : null;
  if (args.since && Number.isNaN(since)) throw new Error(`Invalid --since date: ${args.since}`);
  const report = summarizeTeamPilot({ ...(await readPilotData(dbPath)), since });
  process.stdout.write(args.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[team-pilot-report] ${error.message}`);
    process.exit(1);
  });
}
