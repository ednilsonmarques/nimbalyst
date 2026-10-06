/**
 * Display helpers on atom modules resolve their labels in the current UI
 * language at call time, while ids/values stay unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import { formatResetTime } from '../claudeUsageAtoms';
import { formatCodexWindowLabel, formatCodexWindowSubtitle, type CodexUsageWindow } from '../codexUsageAtoms';
import { describeBackgroundWait } from '../sessionBackgroundTasks';
import { SESSION_PHASE_COLUMNS } from '../sessionKanban';
import { getSuperStatusInfo } from '../superLoop';

afterEach(async () => {
  await setLanguage('en');
});

const win = (windowDurationMins: number | null, slot: 'primary' | 'secondary' = 'primary'): CodexUsageWindow => ({
  slot,
  usedPercent: 0,
  windowDurationMins,
  resetsAt: null,
});

const NOW = 1_000_000_000;
const tasks = [
  { taskId: 'a', description: 'Run the gates', startedAt: NOW - 12 * 60_000 },
  { taskId: 'b', description: '', startedAt: NOW - 30_000 },
];

describe('usage and status display helpers i18n', () => {
  it('keeps the exact original English strings', () => {
    expect(formatResetTime(null)).toBe('Unknown');
    expect(formatResetTime(new Date(Date.now() - 60_000).toISOString())).toBe('Now');
    expect(formatCodexWindowLabel(win(5 * 60))).toBe('Session');
    expect(formatCodexWindowLabel(win(7 * 24 * 60))).toBe('Weekly');
    expect(formatCodexWindowLabel(win(null, 'secondary'))).toBe('Secondary usage');
    expect(formatCodexWindowLabel(win(null))).toBe('Usage');
    expect(formatCodexWindowSubtitle(win(null))).toBe('Usage window');
    expect(formatCodexWindowSubtitle(win(5 * 60))).toBe('5-hour window');
    expect(formatCodexWindowSubtitle(win(7 * 24 * 60))).toBe('7-day window');
    expect(formatCodexWindowSubtitle(win(120))).toBe('2-hour window');
    expect(formatCodexWindowSubtitle(win(90))).toBe('90-minute window');
    expect(describeBackgroundWait([tasks[0]], NOW)).toBe('Waiting on background task: Run the gates (12m)');
    expect(describeBackgroundWait(tasks, NOW)).toBe('Waiting on 2 background tasks: Run the gates (12m); background task (30s)');
    expect(SESSION_PHASE_COLUMNS.map((c) => c.label)).toEqual(['Backlog', 'Planning', 'Implementing', 'Validating', 'Complete']);
    expect(getSuperStatusInfo('paused')).toEqual({ label: 'Paused', color: 'paused' });
  });

  it('renders pt-BR without changing ids', async () => {
    await setLanguage('pt-BR');
    expect(formatResetTime(null)).toBe('Desconhecido');
    expect(formatCodexWindowLabel(win(5 * 60))).toBe('Sessão');
    expect(formatCodexWindowLabel(win(7 * 24 * 60))).toBe('Semanal');
    expect(formatCodexWindowSubtitle(win(5 * 60))).toBe('Janela de 5 h');
    expect(formatCodexWindowSubtitle(win(90))).toBe('Janela de 90 min');
    expect(describeBackgroundWait(tasks, NOW)).toBe(
      'Aguardando 2 tarefas em segundo plano: Run the gates (12m); tarefa em segundo plano (30s)',
    );
    expect(SESSION_PHASE_COLUMNS.map((c) => c.value)).toEqual(['backlog', 'planning', 'implementing', 'validating', 'complete']);
    expect(SESSION_PHASE_COLUMNS.map((c) => c.label)).toEqual(['Backlog', 'Planejamento', 'Implementação', 'Validação', 'Concluído']);
    // Spreading a column (as consumers do) snapshots the current-language label.
    expect({ ...SESSION_PHASE_COLUMNS[1] }.label).toBe('Planejamento');
    expect(getSuperStatusInfo('failed')).toEqual({ label: 'Falhou', color: 'failed' });
  });
});
