import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { extractMessageFacts, readPilotData, renderMarkdown, summarizeTeamPilot } from '../team-pilot-report.mjs';

const SECRET = 'SEGREDO-DO-USUARIO';

const toolUse = (name) => `{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"${name}","input":{"command":"cat ${SECRET}.txt","prompt":"${SECRET}"}}]}}`;
const assistantText = (text) => `{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"${text}"}]}}`;
const toolResult = (text) => `{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"${text}"}]}}`;

function fixture() {
  const sessions = [
    // Team with three members, one promoted.
    { id: 'root-team-0001', createdBySessionId: null, provider: 'claude-code', model: 'claude-code:opus', status: 'idle', metadata: JSON.stringify({ teamMode: true, effortLevel: 'high' }), createdAt: '2026-10-10T15:00:00.000Z' },
    { id: 'exp-1', createdBySessionId: 'root-team-0001', provider: 'claude-code', model: 'claude-code:sonnet', status: 'idle', metadata: JSON.stringify({ teamChild: { role: 'explorer', depth: 1 }, effortLevel: 'medium', toolScope: 'read' }), createdAt: '2026-10-10T15:01:00.000Z' },
    { id: 'impl-1', createdBySessionId: 'root-team-0001', provider: 'claude-code', model: 'claude-code:sonnet', status: 'error', metadata: JSON.stringify({ teamChild: { role: 'implementer', depth: 1 }, effortLevel: 'high' }), createdAt: '2026-10-10T15:02:00.000Z' },
    { id: 'rev-1', createdBySessionId: 'root-team-0001', provider: 'claude-code', model: 'claude-code:opus', status: 'idle', metadata: JSON.stringify({ teamChild: { role: 'reviewer', depth: 1 }, effortLevel: 'high', toolScope: 'review' }), createdAt: '2026-10-10T15:03:00.000Z' },
    // Advisor on its own defaults (Opus/high/read, same provider as the root): not a promotion; it gave one opinion. Its mission is coordinator text and never leaves the database.
    { id: 'adv-1', createdBySessionId: 'root-team-0001', provider: 'claude-code', model: 'claude-code:opus', status: 'idle', metadata: JSON.stringify({ teamChild: { role: 'advisor', depth: 1, mission: `Question the plan about ${SECRET}.` }, effortLevel: 'high', toolScope: 'read' }), createdAt: '2026-10-10T15:04:00.000Z' },
    // Architect on its own defaults (Opus/high/read): not a promotion.
    { id: 'arch-1', createdBySessionId: 'root-team-0001', model: 'claude-code:opus', status: 'idle', metadata: JSON.stringify({ teamChild: { role: 'architect', depth: 1 }, effortLevel: 'high', toolScope: 'read' }), createdAt: '2026-10-10T15:00:30.000Z' },
    // Solo root.
    { id: 'root-solo-0002', createdBySessionId: null, model: 'claude-code:opus', status: 'idle', metadata: { teamMode: true, effortLevel: 'high' }, createdAt: '2026-10-11T09:00:00.000Z' },
    // Normal sessions, one of them delegating: not Team mode.
    { id: 'plain-1', createdBySessionId: null, model: 'claude-code:opus', status: 'idle', metadata: '{}', createdAt: '2026-10-10T10:00:00.000Z' },
    { id: 'plain-child', createdBySessionId: 'plain-1', model: 'claude-code:sonnet', status: 'idle', metadata: '{}', createdAt: '2026-10-10T10:01:00.000Z' },
  ];
  const messages = [
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:00:10.000Z', content: assistantText(`Team plan: TEAM — ${SECRET} explorer and reviewer`) },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:00:20.000Z', content: toolUse('mcp__nimbalyst-host__create_session') },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:00:21.000Z', content: toolUse('mcp__nimbalyst-host__create_session') },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:00:22.000Z', content: toolUse('mcp__nimbalyst-host__create_session') },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:00:23.000Z', content: toolUse('mcp__nimbalyst-host__create_session') },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:00:24.000Z', content: toolResult('Team limit: 3/3 sessions are already active in this team. Wait for a member to finish') },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:10:00.000Z', content: toolUse('mcp__nimbalyst-host__get_session_result') },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:11:00.000Z', content: toolUse('Agent') },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:12:00.000Z', content: toolUse('Bash') },
    { sessionId: 'exp-1', createdAt: '2026-10-10T15:02:00.000Z', content: toolUse('Bash') },
    { sessionId: 'exp-1', createdAt: '2026-10-10T15:02:01.000Z', content: toolResult('<tool_use_error>Error: No such tool available: Bash. Bash is disabled for this session') },
    { sessionId: 'rev-1', createdAt: '2026-10-10T15:20:00.000Z', content: toolUse('mcp__nimbalyst-host__run_project_tests') },
    { sessionId: 'rev-1', createdAt: '2026-10-10T15:25:00.000Z', content: assistantText(`Verdict: blockers found. ${SECRET}`) },
    { sessionId: 'rev-1', createdAt: '2026-10-10T15:30:00.000Z', content: assistantText('Verdict: no blockers') },
    { sessionId: 'arch-1', createdAt: '2026-10-10T15:05:00.000Z', content: assistantText(`\`\`\`yaml\\ntoolManifest: 1\\nid: M-1\\ntask: ${SECRET}\\n\`\`\`\\nPreparation: complete`) },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:06:00.000Z', content: assistantText(`Team plan: TEAM — diverging from M-1 on reviewer model: ${SECRET}`) },
    // A coordinator quoting a manifest is not a manifest.
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:06:30.000Z', content: assistantText('The architect wrote toolManifest: 1 in its report.') },
    // The advisor's opinion counts once; the coordinator quoting it does not.
    { sessionId: 'adv-1', createdAt: '2026-10-10T15:21:00.000Z', content: assistantText(`Independent opinion: approved with reservations. ${SECRET}`) },
    { sessionId: 'root-team-0001', createdAt: '2026-10-10T15:22:00.000Z', content: assistantText('The advisor said Independent opinion: approved with reservations.') },
    { sessionId: 'root-solo-0002', createdAt: '2026-10-11T09:00:05.000Z', content: assistantText('Team plan: SOLO — trivial') },
    { sessionId: 'plain-1', createdAt: '2026-10-10T10:00:05.000Z', content: toolUse('Agent') },
  ];
  const teamNotes = [
    { data: JSON.stringify({ title: SECRET, description: SECRET, customFields: { teamRootSession: 'root-team-0001', noteKind: 'risk' } }) },
    { data: JSON.stringify({ title: SECRET, teamRootSession: 'root-team-0001', noteKind: 'decision' }) },
    { data: JSON.stringify({ title: 'manual note', noteKind: 'context' }) },
  ];
  return { sessions, messages, teamNotes };
}

test('counts Team mode roots only, solo versus team, and members per role', () => {
  const report = summarizeTeamPilot(fixture());
  assert.equal(report.totals.teamRoots, 2);
  assert.equal(report.totals.solo, 1);
  assert.equal(report.totals.team, 1);
  assert.equal(report.totals.members, 5);
  assert.deepEqual(report.totals.membersByRole, { explorer: 1, implementer: 1, reviewer: 1, architect: 1, advisor: 1, other: 0 });
  assert.equal(report.totals.architects, 1);
  assert.equal(report.totals.advisors, 1);
  // Only the advisor's own opinion line counts; the coordinator quoting one does not.
  assert.equal(report.totals.advisorOpinions, 1);
  assert.equal(report.totals.manifests, 1);
  assert.equal(report.totals.manifestDivergences, 1);
  // The normal session that used Agent is not part of the pilot numbers.
  assert.equal(report.totals.tools.Agent, 1);
  assert.deepEqual(report.teams.map((team) => [team.id, team.kind]), [['root-tea', 'team'], ['root-sol', 'solo']]);
});

test('derives tool use, review cycles, blocks, refusals, promotions, notes, errors and duration', () => {
  const [team, solo] = summarizeTeamPilot(fixture()).teams;
  assert.deepEqual(team.tools, { Agent: 1, Task: 0, create_session: 4, spawn_session: 0, get_session_result: 1, run_project_tests: 1, send_prompt: 0 });
  assert.equal(team.reviewers, 1);
  assert.equal(team.reviewCycles, 2);
  assert.equal(team.scopeDenied, 1);
  assert.equal(team.limitRefusals, 1);
  assert.deepEqual(team.declaredPlans, ['TEAM', 'TEAM']);
  assert.equal(team.architects, 1);
  assert.equal(team.advisors, 1);
  assert.equal(team.advisorOpinions, 1);
  assert.equal(team.manifests, 1);
  assert.deepEqual(team.manifestDecisions, ['diverged']);
  assert.deepEqual(team.promotions, [
    { role: 'implementer', model: 'claude-code:sonnet', effort: 'high', modelPromoted: false, effortPromoted: true },
    { role: 'reviewer', model: 'claude-code:opus', effort: 'high', modelPromoted: true, effortPromoted: false },
  ]);
  assert.equal(team.teamNotes, 2);
  assert.equal(team.errors, 1);
  assert.equal(team.durationMinutes, 29.8);
  assert.deepEqual(solo.declaredPlans, ['SOLO']);
  assert.equal(solo.members, 0);
  assert.equal(solo.teamNotes, 0);
});

test('--since keeps only roots created from that instant', () => {
  const report = summarizeTeamPilot({ ...fixture(), since: Date.parse('2026-10-11T00:00:00.000Z') });
  assert.deepEqual(report.teams.map((team) => team.id), ['root-sol']);
});

test('a metric that cannot be derived is unavailable, never zero', () => {
  const report = summarizeTeamPilot({ ...fixture(), messages: null, teamNotes: null });
  assert.equal(report.totals.tools, null);
  assert.equal(report.totals.reviewCycles, null);
  assert.equal(report.totals.scopeDeniedAttempts, null);
  assert.equal(report.totals.limitRefusals, null);
  assert.equal(report.totals.teamNotes, null);
  assert.equal(report.teams[0].durationMinutes, null);
  // What the session rows alone support is still reported.
  assert.equal(report.totals.members, 5);
  assert.equal(report.totals.promotions, 2);
  assert.equal(report.totals.manifests, null);
  assert.equal(report.totals.manifestDivergences, null);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /\| Ciclos de revisão \| indisponível \|/);
  assert.match(markdown, /\| Manifestos do Architect \| indisponível \|/);
  assert.match(markdown, /\| Chamadas create_session \| indisponível \|/);
  assert.doesNotMatch(markdown, /\| Ciclos de revisão \| 0 \|/);
});

test('never outputs prompts, transcript text, note contents, commands or file names', () => {
  const report = summarizeTeamPilot(fixture());
  for (const output of [JSON.stringify(report), renderMarkdown(report)]) {
    assert.equal(output.includes(SECRET), false);
    assert.equal(output.includes('cat '), false);
    assert.equal(output.includes('manual note'), false);
    // Full session ids are shortened.
    assert.equal(output.includes('root-team-0001'), false);
  }
  assert.deepEqual(Object.keys(extractMessageFacts(toolUse('Bash'))).sort(), ['declaredPlan', 'limitRefusals', 'manifestDecision', 'manifests', 'opinions', 'scopeDenied', 'tools', 'verdicts']);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /\| Manifestos do Architect \| 1 \|/);
  assert.match(markdown, /\| Divergências do Coordenador sobre manifestos \| 1 \|/);
  assert.match(markdown, /Membros \(E\/I\/R\/A\/C\/O\)/);
  assert.match(markdown, /\| Pareceres do Consultor Independente \| 1 \|/);
  assert.match(markdown, /5 \(1\/1\/1\/1\/1\/0\)/);
  // A tool that is not on the counted list is not even named.
  assert.deepEqual(extractMessageFacts(toolUse('Bash')).tools, {});
});

test('reports each advisor with provider, model, effort, scope, mission presence and provider diversity against its root', () => {
  const report = summarizeTeamPilot(fixture());
  const [team] = report.teams;
  assert.equal(team.provider, 'claude-code');
  assert.deepEqual(team.advisorSessions, [
    { id: 'adv-1', provider: 'claude-code', model: 'claude-code:opus', effort: 'high', scope: 'read', hasMission: true, providerDiversity: 'same' },
  ]);
  assert.equal(team.advisorsProviderDiverse, 0);
  assert.equal(report.totals.advisorsProviderDiverse, 0);
  const markdown = renderMarkdown(report);
  assert.match(markdown, /\| Consultores Independentes em provider diferente da raiz \| 0 \|/);
  assert.match(markdown, /## Consultores Independentes/);
  assert.match(markdown, /\| root-tea \| adv-1 \| claude-code \| claude-code \| claude-code:opus \| high \| read \| sim \| não \(mesmo provider da raiz\) \|/);
  // The mission text itself is never carried, only that one exists.
  assert.equal(JSON.stringify(report).includes(SECRET), false);

  // An advisor on another provider than its root is the provider-diverse case.
  const diverse = fixture();
  const advisor = diverse.sessions.find((session) => session.id === 'adv-1');
  advisor.provider = 'openai-codex';
  advisor.model = 'openai-codex:gpt-5.5';
  const diverseReport = summarizeTeamPilot(diverse);
  assert.deepEqual(diverseReport.teams[0].advisorSessions[0], { id: 'adv-1', provider: 'openai-codex', model: 'openai-codex:gpt-5.5', effort: 'high', scope: 'read', hasMission: true, providerDiversity: 'diverse' });
  assert.equal(diverseReport.totals.advisorsProviderDiverse, 1);
  assert.match(renderMarkdown(diverseReport), /\| root-tea \| adv-1 \| openai-codex \| claude-code \| openai-codex:gpt-5.5 \| high \| read \| sim \| sim \(provider diferente\) \|/);

  // Rows without a provider (older databases) report the diversity as unavailable, never as same or diverse.
  const unknown = fixture();
  delete unknown.sessions.find((session) => session.id === 'root-team-0001').provider;
  assert.equal(summarizeTeamPilot(unknown).teams[0].advisorSessions[0].providerDiversity, null);
  assert.match(renderMarkdown(summarizeTeamPilot(unknown)), /\| sim \| indisponível \|/);
});

test('the same words inside a file a session read are not counted as events', () => {
  const readResult = toolResult('1\tif (usage.total >= budget) return `Team budget reached: this team has already created`;\n2\t// No such tool available: Bash');
  const facts = extractMessageFacts(readResult);
  assert.equal(facts.limitRefusals, 0);
  assert.equal(facts.scopeDenied, 0);
  assert.equal(extractMessageFacts(toolResult('Team budget reached: this team has already created 8/8 sessions.')).limitRefusals, 1);
  assert.equal(extractMessageFacts(toolResult('Error: Team depth limit reached: this session is at depth 2')).limitRefusals, 1);
});

test('a plan quoted in a user message is not taken as a declared plan', () => {
  const facts = extractMessageFacts('{"type":"user","message":{"role":"user","content":"Team plan: TEAM"}}');
  assert.equal(facts.declaredPlan, null);
});

test('manifests and manifest decisions are read only from assistant text blocks, never from briefs, notes or thinking', () => {
  // A brief inside a tool_use input that cites the decision.
  const brief = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_2","name":"mcp__nimbalyst-host__create_session","input":{"role":"reviewer","prompt":"Team plan: TEAM — diverging from M-1 on tests: check them"}}]}}';
  assert.equal(extractMessageFacts(brief).manifestDecision, null);
  // A draft of the manifest in a thinking block.
  const thinking = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"draft:\\ntoolManifest: 1\\nid: M-1"}]}}';
  assert.equal(extractMessageFacts(thinking).manifests, 0);
  // A Grep result quoting the marker is a user (tool_result) message.
  assert.equal(extractMessageFacts(toolResult('toolManifest: 1')).manifests, 0);
  // A tool whose input has a real `text` key (voice_agent_speak, a Slack MCP) is not a text block.
  const textInput = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_3","name":"mcp__nimbalyst-situational__voice_agent_speak","input":{"text":"Team plan: TEAM — diverging from M-1 on x: y"}}]}}';
  assert.equal(extractMessageFacts(textInput).manifestDecision, null);
  assert.equal(extractMessageFacts('{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_4","name":"Write","input":{"text":"toolManifest: 1"}}]}}').manifests, 0);
  // The real thing: a text block.
  assert.equal(extractMessageFacts(assistantText('```yaml\\ntoolManifest: 1\\nid: M-2\\n```')).manifests, 1);
  assert.equal(extractMessageFacts(assistantText('Team plan: SOLO — per manifest M-2. Next: ...')).manifestDecision, 'accepted');
  // The decision needs the Team plan line; a stray mention elsewhere in the text is not a decision.
  assert.equal(extractMessageFacts(assistantText('I recorded the note "diverging from M-1" as asked.')).manifestDecision, null);
});

test('reads a real database read-only without creating anything in it', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'team-pilot-report-'));
  const dbPath = path.join(dir, 'nimbalyst.sqlite');
  try {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE ai_sessions (id TEXT PRIMARY KEY, created_by_session_id TEXT, provider TEXT, model TEXT, status TEXT, metadata TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE ai_agent_messages (id INTEGER PRIMARY KEY, session_id TEXT, created_at TEXT, content TEXT);
      CREATE TABLE tracker_items (id TEXT PRIMARY KEY, type TEXT, data TEXT);
    `);
    const data = fixture();
    const insertSession = db.prepare('INSERT INTO ai_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (const s of data.sessions) insertSession.run(s.id, s.createdBySessionId, s.provider ?? null, s.model, s.status, typeof s.metadata === 'string' ? s.metadata : JSON.stringify(s.metadata), s.createdAt, s.createdAt);
    const insertMessage = db.prepare('INSERT INTO ai_agent_messages (session_id, created_at, content) VALUES (?, ?, ?)');
    for (const m of data.messages) insertMessage.run(m.sessionId, m.createdAt, m.content);
    const insertNote = db.prepare('INSERT INTO tracker_items VALUES (?, ?, ?)');
    data.teamNotes.forEach((note, index) => insertNote.run(`note-${index}`, 'team-note', note.data));
    const tablesBefore = db.prepare("SELECT name FROM sqlite_master ORDER BY name").all();
    db.close();

    const read = await readPilotData(dbPath);
    // Messages of sessions outside any team are not even read.
    assert.equal(read.messages.some((message) => message.sessionId === 'plain-1'), false);
    const report = summarizeTeamPilot(read);
    assert.equal(report.totals.teamRoots, 2);
    assert.equal(report.totals.tools.create_session, 4);
    assert.equal(report.totals.tools.Agent, 1);
    assert.equal(report.totals.teamNotes, 3);
    assert.equal(report.totals.manifests, 1);
    assert.equal(report.teams[0].advisorSessions[0].providerDiversity, 'same');

    const after = new DatabaseSync(dbPath, { readOnly: true });
    assert.deepEqual(after.prepare("SELECT name FROM sqlite_master ORDER BY name").all(), tablesBefore);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
