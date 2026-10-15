/**
 * NIB.39 / i18n residual: the Team view's role counts and the transcript's
 * waiting indicator pluralize through i18next in both languages, never by
 * concatenating an English "s" ("2 Consultor Independente", "2 sessions").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, t } from '../index';

afterEach(async () => {
  await setLanguage('en');
});

describe('team role counts', () => {
  it('pt-BR pluralizes each role, the advisor included', async () => {
    await setLanguage('pt-BR');
    expect(t('agent:agentTeam.roleCounts.advisor', { count: 1 })).toBe('1 Consultor Independente');
    expect(t('agent:agentTeam.roleCounts.advisor', { count: 2 })).toBe('2 Consultores Independentes');
    expect(t('agent:agentTeam.roleCounts.architect', { count: 2 })).toBe('2 Arquitetos');
    expect(t('agent:agentTeam.roleCounts.coordinator', { count: 3 })).toBe('3 Coordenadores');
    expect(t('agent:agentTeam.roleCounts.other', { count: 2 })).toBe('2 Membros');
    expect(t('agent:agentTeam.roleCounts.advisor', { count: 0 })).toBe('0 Consultores Independentes');
  });

  it('en pluralizes each role too', async () => {
    await setLanguage('en');
    expect(t('agent:agentTeam.roleCounts.advisor', { count: 1 })).toBe('1 Independent Advisor');
    expect(t('agent:agentTeam.roleCounts.advisor', { count: 2 })).toBe('2 Independent Advisors');
    expect(t('agent:agentTeam.roleCounts.reviewer', { count: 2 })).toBe('2 Reviewers');
  });
});

describe('transcript waiting indicator', () => {
  it('pt-BR: Pensando..., agentes and sessões in natural Portuguese', async () => {
    await setLanguage('pt-BR');
    expect(t('ai:transcript.thinking')).toBe('Pensando...');
    expect(t('ai:transcript.waitingForAgents', { count: 1 })).toBe('Aguardando 1 agente...');
    expect(t('ai:transcript.waitingForAgents', { count: 2 })).toBe('Aguardando 2 agentes...');
    expect(t('ai:transcript.waitingForSessions', { count: 1 })).toBe('Aguardando 1 sessão...');
    expect(t('ai:transcript.waitingForSessions', { count: 2 })).toBe('Aguardando 2 sessões...');
  });

  it('en keeps its wording', async () => {
    await setLanguage('en');
    expect(t('ai:transcript.thinking')).toBe('Thinking...');
    expect(t('ai:transcript.waitingForAgents', { count: 1 })).toBe('Waiting for 1 agent to complete...');
    expect(t('ai:transcript.waitingForSessions', { count: 3 })).toBe('Waiting for 3 sessions to complete...');
  });
});
