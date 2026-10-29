/**
 * The Team front proposal card (F1.1): what the user reads, how they decide, and that the
 * decision goes through the host's own channel (teamFrontProposalDecide), never a prompt answer.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Provider as JotaiProvider } from 'jotai';
import { store } from '../../../../../store/store';
import { setInteractiveWidgetHost } from '../../../../../store/atoms/interactiveWidgetHost';
import { I18nProvider } from '../../../../../i18n/react';
import { setLanguage } from '../../../../../i18n';
import { TeamFrontProposalWidget } from '../TeamFrontProposalWidget';
import { getCustomToolWidget } from '../index';
import type {
  InteractiveWidgetHost,
  TeamFrontProposalDecidePayload,
  TeamFrontProposalDecideResult,
  TeamFrontProposalStateResult,
} from '../InteractiveWidgetHost';
import { isInteractiveWidgetTool } from '../../../../../ai/server/interactivePromptTools';
import { TEAM_FRONT_PROPOSAL_TOOL_NAME } from '../../../../../ai/server/providers/teamContext';

const SESSION = 'root-session';
const PROPOSAL = 'tfp_00000000-0000-0000-0000-000000000001';

const EVIL_TITLE = '<b>Billing</b> **bold** [link](http://x.test) <img src=x onerror=alert(1)>';
const ITEMS = [
  { action: 'create', title: EVIL_TITLE, description: '# Heading\n<script>alert(1)</script>\n- one', status: 'active' },
  { action: 'status', frontId: 'tfr_1', frontTitle: 'Portal', fromStatus: 'active', status: 'paused', activeMission: { title: 'Portal: tooltips' } },
  { action: 'status', frontId: 'tfr_2', frontTitle: 'Old', fromStatus: 'paused', status: 'closed', activeMission: null },
];

function message(result: unknown = null, items: unknown[] = ITEMS) {
  return {
    toolCall: {
      providerToolCallId: `team-front-proposal-${PROPOSAL}`,
      toolName: 'TeamFrontProposal',
      arguments: { proposalId: PROPOSAL, rootSessionId: SESSION, items },
      result,
    },
  } as any;
}

type HostOptions = {
  state?: TeamFrontProposalStateResult | Error;
  decide?: TeamFrontProposalDecideResult | Error;
  methods?: boolean;
  result?: unknown;
  items?: unknown[];
};

async function renderIn(language: 'en' | 'pt-BR', options: HostOptions = {}) {
  await act(async () => {
    await setLanguage(language);
  });
  const teamFrontProposalState = vi.fn(async (): Promise<TeamFrontProposalStateResult> => {
    if (options.state instanceof Error) throw options.state;
    return options.state ?? { success: true, state: 'pending' };
  });
  const teamFrontProposalDecide = vi.fn(async (_payload: TeamFrontProposalDecidePayload): Promise<TeamFrontProposalDecideResult> => {
    if (options.decide instanceof Error) throw options.decide;
    return options.decide ?? {
      success: true,
      results: [{ index: 0, action: 'create', label: 'x', result: 'written', id: 'tfr_9', status: 'active' }],
    };
  });
  const host = (options.methods === false ? {} : { teamFrontProposalState, teamFrontProposalDecide }) as unknown as InteractiveWidgetHost;
  setInteractiveWidgetHost(SESSION, host);
  const view = render(
    <JotaiProvider store={store}>
      <I18nProvider>
        <TeamFrontProposalWidget message={message(options.result ?? null, options.items ?? ITEMS)} sessionId={SESSION} {...({} as any)} />
      </I18nProvider>
    </JotaiProvider>,
  );
  await act(async () => {});
  return { teamFrontProposalState, teamFrontProposalDecide, view };
}

const widget = () => screen.getByTestId('team-front-proposal-widget');
const text = () => widget().textContent ?? '';
const click = async (id: string) => { await act(async () => { fireEvent.click(screen.getByTestId(id)); }); };
const submit = () => screen.getByTestId('team-front-proposal-submit') as HTMLButtonElement;

afterEach(async () => {
  cleanup();
  setInteractiveWidgetHost(SESSION, null);
  await setLanguage('en');
});

describe('registration', () => {
  it('is the widget of the TeamFrontProposal card and always renders, even with tool calls hidden', () => {
    expect(TEAM_FRONT_PROPOSAL_TOOL_NAME).toBe('TeamFrontProposal');
    expect(getCustomToolWidget(TEAM_FRONT_PROPOSAL_TOOL_NAME)).toBe(TeamFrontProposalWidget);
    expect(isInteractiveWidgetTool(TEAM_FRONT_PROPOSAL_TOOL_NAME)).toBe(true);
    expect(isInteractiveWidgetTool(`mcp__nimbalyst-host__${TEAM_FRONT_PROPOSAL_TOOL_NAME}`)).toBe(true);
  });
});

describe('plain-text rendering of agent text', () => {
  it('shows markup and markdown from the coordinator as literal text, never as elements', async () => {
    const { view } = await renderIn('en');
    expect(screen.getByTestId('team-front-proposal-title-0').textContent).toBe(EVIL_TITLE);
    expect(screen.getByTestId('team-front-proposal-description-0').textContent).toBe(ITEMS[0].description);
    const root = view.container;
    for (const tag of ['b', 'script', 'img', 'a', 'h1', 'strong', 'em', 'ul', 'li']) {
      expect(root.querySelector(tag), tag).toBeNull();
    }
    expect(screen.getByTestId('team-front-proposal-warning-1').textContent).toContain('Portal: tooltips');
  });

  it('a mission title with markup is also plain text', async () => {
    const items = [{ ...ITEMS[1], activeMission: { title: '<i>m</i>' } }];
    const { view } = await renderIn('en', { items });
    expect(screen.getByTestId('team-front-proposal-warning-0').textContent).toContain('<i>m</i>');
    expect(view.container.querySelector('i')).toBeNull();
  });

  it('renders nothing for a card it cannot read (no id, no items, an unknown status)', async () => {
    for (const items of [[], [{ action: 'create', title: 'x', description: 'y', status: 'archived' }], [{ action: 'delete' }]]) {
      const { view } = await renderIn('en', { items });
      expect(view.container.querySelector('[data-testid="team-front-proposal-widget"]'), JSON.stringify(items)).toBeNull();
      cleanup();
    }
  });
});

describe('what the user reads', () => {
  it('in English: kinds, suggested status, status change, the D1 pause warning', async () => {
    await renderIn('en');
    expect(widget().getAttribute('data-state')).toBe('pending');
    expect(text()).toContain('Your coordinator proposes 3 changes to the project\'s fronts. Nothing is written until you decide.');
    expect(text()).toContain('New front');
    expect(text()).toContain('Suggested status: Active');
    expect(text()).toContain('Status: Active → Paused');
    expect(screen.getByTestId('team-front-proposal-warning-1').textContent).toContain('has an active mission ("Portal: tooltips")');
    expect(screen.queryByTestId('team-front-proposal-warning-2')).toBeNull();
  });

  it('in pt-BR with the product terms', async () => {
    await renderIn('pt-BR');
    expect(text()).toContain('Seu coordenador propõe 3 mudanças nas frentes do projeto. Nada é gravado até você decidir.');
    expect(text()).toContain('Nova frente');
    expect(text()).toContain('Status sugerido: Ativa');
    expect(text()).toContain('Status: Ativa → Pausada');
    expect(screen.getByTestId('team-front-proposal-warning-1').textContent).toContain('tem uma missão ativa ("Portal: tooltips")');
    expect(screen.getByTestId('team-front-proposal-approve-all').textContent).toBe('Aprovar tudo');
    expect(submit().textContent).toBe('Enviar decisão');
    expect(text()).not.toMatch(/Front proposal|Approve|Your coordinator/);
  });

  it('uses the singular plural form for a single item', async () => {
    await renderIn('pt-BR', { items: [ITEMS[0]] });
    expect(text()).toContain('Seu coordenador propõe 1 mudança nas frentes do projeto.');
  });
});

describe('deciding', () => {
  it('the submit stays disabled until every item has a decision, then sends exactly one decision by index', async () => {
    const { teamFrontProposalDecide } = await renderIn('en');
    expect(submit().disabled).toBe(true);
    expect(screen.getByTestId('team-front-proposal-hint').textContent).toBe('Approve or reject each item to continue.');
    await click('team-front-proposal-approve-0');
    await click('team-front-proposal-reject-1');
    expect(submit().disabled).toBe(true);
    await click('team-front-proposal-approve-2');
    expect(submit().disabled).toBe(false);
    await click('team-front-proposal-submit');
    expect(teamFrontProposalDecide).toHaveBeenCalledTimes(1);
    expect(teamFrontProposalDecide).toHaveBeenCalledWith({
      proposalId: PROPOSAL,
      rootSessionId: SESSION,
      items: [{ index: 0, decision: 'approve' }, { index: 1, decision: 'reject' }, { index: 2, decision: 'approve' }],
    });
  });

  it('"Approve all" approves every item and "Reject all" rejects every item (the way out of an ignored card)', async () => {
    const { teamFrontProposalDecide } = await renderIn('en');
    await click('team-front-proposal-approve-all');
    expect(screen.getByTestId('team-front-proposal-item-1').getAttribute('data-decision')).toBe('approve');
    await click('team-front-proposal-reject-all');
    for (const i of [0, 1, 2]) expect(screen.getByTestId(`team-front-proposal-item-${i}`).getAttribute('data-decision')).toBe('reject');
    await click('team-front-proposal-submit');
    expect(teamFrontProposalDecide.mock.calls[0][0].items).toEqual([
      { index: 0, decision: 'reject' }, { index: 1, decision: 'reject' }, { index: 2, decision: 'reject' },
    ]);
  });

  it('shows what was written and closes the controls after the decision; a second click cannot send again', async () => {
    const { teamFrontProposalDecide } = await renderIn('en', {
      decide: {
        success: true,
        results: [
          { index: 0, action: 'create', label: 'Billing', result: 'written', id: 'tfr_9', status: 'active' },
          { index: 1, action: 'status', label: 'Portal', result: 'refused', code: 'mission-started-after-card' },
          { index: 2, action: 'status', label: 'Old', result: 'rejected' },
        ],
      },
    });
    await click('team-front-proposal-approve-all');
    await click('team-front-proposal-submit');
    expect(widget().getAttribute('data-state')).toBe('decided');
    expect(screen.getByTestId('team-front-proposal-result-0').textContent).toBe('Written: Billing (Active)');
    expect(screen.getByTestId('team-front-proposal-result-1').textContent).toContain('Not written: Portal. A mission started on this front after the proposal was shown.');
    expect(screen.getByTestId('team-front-proposal-result-2').textContent).toBe('Rejected: Old');
    expect(screen.queryByTestId('team-front-proposal-submit')).toBeNull();
    expect(teamFrontProposalDecide).toHaveBeenCalledTimes(1);
  });

  it('a written item whose team sharing failed says so', async () => {
    await renderIn('pt-BR', { decide: { success: true, results: [{ index: 0, action: 'create', label: 'Billing', result: 'written', status: 'active', ...({ syncWarning: 'x' } as object) }] } });
    await click('team-front-proposal-approve-all');
    await click('team-front-proposal-submit');
    expect(screen.getByTestId('team-front-proposal-result-0').textContent).toContain('Gravada: Billing (Ativa)');
    expect(screen.getByTestId('team-front-proposal-sync-warning').textContent).toBe('Gravada, mas o compartilhamento com a equipe não foi concluído.');
  });
});

describe('editing', () => {
  it('a create can edit title, description and status; only the changed fields are sent, trimmed', async () => {
    const { teamFrontProposalDecide } = await renderIn('en');
    await click('team-front-proposal-edit-0');
    fireEvent.change(screen.getByTestId('team-front-proposal-input-title-0'), { target: { value: '  Billing v2 ' } });
    fireEvent.change(screen.getByTestId('team-front-proposal-input-status-0'), { target: { value: 'paused' } });
    await click('team-front-proposal-approve-all');
    expect(screen.getByTestId('team-front-proposal-edited-0')).toBeTruthy();
    await click('team-front-proposal-submit');
    expect(teamFrontProposalDecide.mock.calls[0][0].items[0]).toEqual({ index: 0, decision: 'approve', edits: { title: 'Billing v2', status: 'paused' } });
    expect(teamFrontProposalDecide.mock.calls[0][0].items[1]).toEqual({ index: 1, decision: 'approve' });
  });

  it('a status change can edit only the status: no title or description input exists for it', async () => {
    const { teamFrontProposalDecide } = await renderIn('en');
    await click('team-front-proposal-edit-2');
    expect(screen.queryByTestId('team-front-proposal-input-title-2')).toBeNull();
    expect(screen.queryByTestId('team-front-proposal-input-description-2')).toBeNull();
    fireEvent.change(screen.getByTestId('team-front-proposal-input-status-2'), { target: { value: 'active' } });
    await click('team-front-proposal-approve-all');
    await click('team-front-proposal-submit');
    expect(teamFrontProposalDecide.mock.calls[0][0].items[2]).toEqual({ index: 2, decision: 'approve', edits: { status: 'active' } });
  });

  it('never sends a type, a target id or any field the item does not allow', async () => {
    const { teamFrontProposalDecide } = await renderIn('en');
    await click('team-front-proposal-approve-all');
    await click('team-front-proposal-submit');
    const sent = JSON.stringify(teamFrontProposalDecide.mock.calls[0][0]);
    expect(sent).not.toMatch(/frontId|tfr_|"type"|currentMission|hostOwned/);
  });

  it('editing a pause to a close shows that a front with an active mission cannot be closed', async () => {
    await renderIn('en');
    await click('team-front-proposal-edit-1');
    fireEvent.change(screen.getByTestId('team-front-proposal-input-status-1'), { target: { value: 'closed' } });
    expect(screen.getByTestId('team-front-proposal-blocked-1').textContent).toContain('cannot be closed');
    expect(screen.queryByTestId('team-front-proposal-warning-1')).toBeNull();
  });

  it('an empty or oversize title blocks the submit of an approved item, not of a rejected one', async () => {
    await renderIn('en');
    await click('team-front-proposal-edit-0');
    fireEvent.change(screen.getByTestId('team-front-proposal-input-title-0'), { target: { value: '   ' } });
    await click('team-front-proposal-approve-all');
    expect(submit().disabled).toBe(true);
    expect(screen.getByTestId('team-front-proposal-problem-0').textContent).toBe('The title must have 1 to 120 characters.');
    expect(screen.getByTestId('team-front-proposal-hint').textContent).toBe('Fix the edited values before sending.');
    await click('team-front-proposal-reject-0');
    expect(submit().disabled).toBe(false);
  });
});

describe('expired, unsupported and refused', () => {
  it('says the proposal is no longer pending when the host does not hold it (restart, settled), with nothing to click', async () => {
    const { teamFrontProposalDecide } = await renderIn('pt-BR', { state: { success: true, state: 'expired' } });
    expect(widget().getAttribute('data-state')).toBe('expired');
    expect(screen.getByTestId('team-front-proposal-expired').textContent).toBe('Esta proposta foi encerrada. Confira o resultado no Rastreador.');
    expect(screen.queryByTestId('team-front-proposal-submit')).toBeNull();
    expect(teamFrontProposalDecide).not.toHaveBeenCalled();
  });

  it('treats a failed state check as expired (nothing approvable)', async () => {
    await renderIn('en', { state: new Error('ipc down') });
    expect(widget().getAttribute('data-state')).toBe('expired');
  });

  it('a host that cannot decide (mobile) keeps the card read-only', async () => {
    await renderIn('pt-BR', { methods: false });
    expect(screen.getByTestId('team-front-proposal-desktop-only').textContent).toBe('Abra esta sessão no aplicativo desktop para decidir esta proposta.');
    expect(screen.queryByTestId('team-front-proposal-submit')).toBeNull();
  });

  it('shows the persisted outcome after a reload, localized, without asking the host', async () => {
    const result = JSON.stringify({
      decided: true,
      results: [
        { index: 0, action: 'create', label: 'Billing', result: 'written', id: 'tfr_9', status: 'paused' },
        { index: 1, action: 'status', label: 'Portal', result: 'refused', code: 'close-with-active-mission', detail: 'English detail never shown' },
      ],
    });
    const { teamFrontProposalState } = await renderIn('pt-BR', { result });
    expect(widget().getAttribute('data-state')).toBe('decided');
    expect(text()).toContain('Gravada: Billing (Pausada)');
    expect(text()).toContain('Não gravada: Portal. A frente tem uma missão ativa e não pode ser fechada.');
    expect(text()).not.toContain('English detail');
    expect(teamFrontProposalState).not.toHaveBeenCalled();
  });

  it('a result that is not the host\'s own outcome does not close the card', async () => {
    for (const result of ['{"decision":"allow"}', 'allow', '{"decided":true}', '{"decided":true,"results":"x"}']) {
      await renderIn('en', { result });
      expect(widget().getAttribute('data-state'), result).toBe('pending');
      cleanup();
    }
  });

  it('keeps the card pending and says why when the host refuses the decision', async () => {
    for (const [code, expected] of [
      ['invalid', 'The decision was not accepted.'],
      ['forbidden', 'This window cannot decide this proposal.'],
      ['unavailable', 'The decision could not be processed.'],
    ] as const) {
      await renderIn('en', { decide: { success: false, code } });
      await click('team-front-proposal-approve-all');
      await click('team-front-proposal-submit');
      expect(widget().getAttribute('data-state'), code).toBe('pending');
      expect(screen.getByTestId('team-front-proposal-error').textContent).toContain(expected);
      expect(submit().disabled).toBe(false);
      cleanup();
    }
  });

  it('an expired or ineligible answer closes the card as expired', async () => {
    for (const code of ['expired', 'root-ineligible']) {
      await renderIn('en', { decide: { success: false, code } });
      await click('team-front-proposal-approve-all');
      await click('team-front-proposal-submit');
      expect(widget().getAttribute('data-state'), code).toBe('expired');
      cleanup();
    }
  });

  it('a thrown IPC error is reported and does not lose the choices', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderIn('pt-BR', { decide: new Error('ipc down') });
    await click('team-front-proposal-approve-all');
    await click('team-front-proposal-submit');
    expect(screen.getByTestId('team-front-proposal-error').textContent).toBe('Não foi possível processar a decisão. Tente de novo.');
    expect(screen.getByTestId('team-front-proposal-item-0').getAttribute('data-decision')).toBe('approve');
    error.mockRestore();
  });
});

describe('the decision is not a prompt answer', () => {
  it('uses only the two proposal methods of the host', async () => {
    const answers = {
      toolPermissionSubmit: vi.fn(), askUserQuestionSubmit: vi.fn(), exitPlanModeApprove: vi.fn(), teamContinue: vi.fn(),
    };
    const { teamFrontProposalDecide } = await renderIn('en');
    setInteractiveWidgetHost(SESSION, { ...answers, teamFrontProposalState: async () => ({ success: true, state: 'pending' }), teamFrontProposalDecide } as unknown as InteractiveWidgetHost);
    await click('team-front-proposal-approve-all');
    await click('team-front-proposal-submit');
    for (const fn of Object.values(answers)) expect(fn).not.toHaveBeenCalled();
    expect(teamFrontProposalDecide).toHaveBeenCalledTimes(1);
  });
});

describe('pt-BR details (i18n review)', () => {
  it('closeBlocked, a field problem, the select options and the pt-BR button states agree in gender', async () => {
    await renderIn('pt-BR');
    await click('team-front-proposal-edit-1');
    fireEvent.change(screen.getByTestId('team-front-proposal-input-status-1'), { target: { value: 'closed' } });
    expect(screen.getByTestId('team-front-proposal-blocked-1').textContent).toBe('Esta frente tem uma missão ativa, então não pode ser fechada. Escolha outro status ou rejeite este item.');
    const options = Array.from(screen.getByTestId('team-front-proposal-input-status-1').querySelectorAll('option')).map((o) => o.textContent);
    expect(options).toEqual(['Ativa', 'Pausada', 'Fechada']);

    await click('team-front-proposal-edit-0');
    fireEvent.change(screen.getByTestId('team-front-proposal-input-title-0'), { target: { value: '   ' } });
    await click('team-front-proposal-approve-0');
    expect(screen.getByTestId('team-front-proposal-approve-0').textContent).toBe('Aprovada');
    expect(screen.getByTestId('team-front-proposal-problem-0').textContent).toBe('O título deve ter de 1 a 120 caracteres.');
    fireEvent.change(screen.getByTestId('team-front-proposal-input-title-0'), { target: { value: 'Ok' } });
    fireEvent.change(screen.getByTestId('team-front-proposal-input-description-0'), { target: { value: ' ' } });
    expect(screen.getByTestId('team-front-proposal-problem-0').textContent).toBe('A descrição deve ter de 1 a 2000 caracteres.');
    await click('team-front-proposal-reject-0');
    expect(screen.getByTestId('team-front-proposal-reject-0').textContent).toBe('Rejeitada');
  });

  it('the refusal codes the host can answer with', async () => {
    for (const [code, expected] of [
      ['invalid', 'A decisão não foi aceita. Confira os valores editados e tente de novo.'],
      ['forbidden', 'Esta janela não pode decidir esta proposta.'],
    ] as const) {
      await renderIn('pt-BR', { decide: { success: false, code } });
      await click('team-front-proposal-approve-all');
      await click('team-front-proposal-submit');
      expect(screen.getByTestId('team-front-proposal-error').textContent).toBe(expected);
      cleanup();
    }
  });

  it('result labels: rejected, refused, failed, and a refusal code this build does not know', async () => {
    const result = JSON.stringify({
      decided: true,
      results: [
        { index: 0, action: 'create', label: 'A', result: 'rejected' },
        { index: 1, action: 'create', label: 'B', result: 'refused', code: 'duplicate-title' },
        { index: 2, action: 'status', label: 'C', result: 'failed', code: 'write-failed' },
        { index: 3, action: 'status', label: 'D', result: 'refused', code: 'some-future-code' },
        { index: 4, action: 'status', label: 'E', result: 'written', status: 'archived' },
      ],
    });
    await renderIn('pt-BR', { result });
    const line = (i: number) => screen.getByTestId(`team-front-proposal-result-${i}`).textContent;
    expect(line(0)).toBe('Rejeitada: A');
    expect(line(1)).toBe('Não gravada: B. Já existe uma frente com este título.');
    expect(line(2)).toBe('Falhou: C. Não foi possível gravar a mudança.');
    expect(line(3)).toBe('Não gravada: D. O Nimbalyst recusou esta mudança.');
    expect(line(4)).toBe('Gravada: E (Status desconhecido)');
  });

  it('English: the neutral refusal reason and the unknown status', async () => {
    const result = JSON.stringify({
      decided: true,
      results: [
        { index: 0, action: 'status', label: 'D', result: 'refused', code: 'some-future-code' },
        { index: 1, action: 'status', label: 'E', result: 'written', status: 'archived' },
      ],
    });
    await renderIn('en', { result });
    expect(screen.getByTestId('team-front-proposal-result-0').textContent).toBe('Not written: D. Nimbalyst refused this change.');
    expect(screen.getByTestId('team-front-proposal-result-1').textContent).toBe('Written: E (Unknown status)');
  });

  it('a stored status the card does not know is shown as unknown, never raw', async () => {
    const items = [{ action: 'status', frontId: 'tfr_1', frontTitle: 'Portal', fromStatus: 'archived-old', status: 'paused', activeMission: null }];
    await renderIn('pt-BR', { items });
    expect(text()).toContain('Status: Status desconhecido → Pausada');
    expect(text()).not.toContain('archived-old');
  });
});

describe('no raw i18n key reaches the screen (pt-BR and en)', () => {
  const noRawKeys = () => expect(text()).not.toMatch(/teamFrontProposal\./);

  it('pending, with editors open', async () => {
    for (const language of ['pt-BR', 'en'] as const) {
      await renderIn(language);
      for (const i of [0, 1, 2]) await click(`team-front-proposal-edit-${i}`);
      await click('team-front-proposal-approve-all');
      noRawKeys();
      cleanup();
    }
  });

  it('decided (live and persisted) and expired', async () => {
    const result = JSON.stringify({ decided: true, results: [{ index: 0, action: 'create', label: 'A', result: 'written', status: 'active' }, { index: 1, action: 'status', label: 'B', result: 'refused', code: 'no-change' }] });
    for (const language of ['pt-BR', 'en'] as const) {
      await renderIn(language, { result });
      noRawKeys();
      cleanup();
      await renderIn(language, { state: { success: true, state: 'expired' } });
      noRawKeys();
      cleanup();
      await renderIn(language, { decide: { success: true, results: [{ index: 0, action: 'create', label: 'A', result: 'failed', code: 'write-failed' }] } });
      await click('team-front-proposal-approve-all');
      await click('team-front-proposal-submit');
      noRawKeys();
      cleanup();
    }
  });

  it('failures and the read-only host', async () => {
    for (const language of ['pt-BR', 'en'] as const) {
      for (const code of ['invalid', 'forbidden', 'unavailable']) {
        await renderIn(language, { decide: { success: false, code } });
        await click('team-front-proposal-approve-all');
        await click('team-front-proposal-submit');
        noRawKeys();
        cleanup();
      }
      await renderIn(language, { methods: false });
      noRawKeys();
      cleanup();
    }
  });
});

describe('expired text after a write whose card result was lost', () => {
  it('is neutral: it never claims nothing was written (the write may have happened)', async () => {
    await renderIn('en', { state: { success: true, state: 'expired' } });
    expect(screen.getByTestId('team-front-proposal-expired').textContent).toBe('This proposal is closed. Check the Tracker for its result.');
    expect(text()).not.toMatch(/nothing was written/i);
    cleanup();
    await renderIn('pt-BR', { state: { success: true, state: 'expired' } });
    expect(text()).not.toMatch(/nada foi gravado/i);
  });
});

describe('closing a front that has an active mission cannot be approved (A5)', () => {
  const closing = { action: 'status', frontId: 'tfr_1', frontTitle: 'Portal', fromStatus: 'active', status: 'closed', activeMission: { title: 'Portal: tooltips' } };

  it('a stored close of such a front: Approve is disabled and the closeBlocked text is shown; Reject still works and unblocks the submit', async () => {
    const { teamFrontProposalDecide } = await renderIn('pt-BR', { items: [closing] });
    expect((screen.getByTestId('team-front-proposal-approve-0') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('team-front-proposal-blocked-0').textContent).toBe('Esta frente tem uma missão ativa, então não pode ser fechada. Escolha outro status ou rejeite este item.');
    await click('team-front-proposal-approve-all');
    expect(submit().disabled).toBe(true);
    await click('team-front-proposal-reject-0');
    expect(submit().disabled).toBe(false);
    await click('team-front-proposal-submit');
    expect(teamFrontProposalDecide.mock.calls[0][0].items).toEqual([{ index: 0, decision: 'reject' }]);
  });

  it('an edit to close disables Approve, and an approval made before the edit cannot be submitted', async () => {
    const { teamFrontProposalDecide } = await renderIn('en', { items: [ITEMS[1]] });
    await click('team-front-proposal-approve-0');
    await click('team-front-proposal-edit-0');
    expect(submit().disabled).toBe(false);
    fireEvent.change(screen.getByTestId('team-front-proposal-input-status-0'), { target: { value: 'closed' } });
    expect((screen.getByTestId('team-front-proposal-approve-0') as HTMLButtonElement).disabled).toBe(true);
    expect(submit().disabled).toBe(true);
    await click('team-front-proposal-submit');
    expect(teamFrontProposalDecide).not.toHaveBeenCalled();
    // choosing another status releases it
    fireEvent.change(screen.getByTestId('team-front-proposal-input-status-0'), { target: { value: 'active' } });
    expect((screen.getByTestId('team-front-proposal-approve-0') as HTMLButtonElement).disabled).toBe(false);
    expect(submit().disabled).toBe(false);
  });

  it('a close of a front without an active mission is approvable', async () => {
    await renderIn('en', { items: [ITEMS[2]] });
    expect((screen.getByTestId('team-front-proposal-approve-0') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByTestId('team-front-proposal-blocked-0')).toBeNull();
  });
});

describe('unknown codes of a failed write (i18n minor)', () => {
  it('a failed result with an unknown code shows the write-failed reason, not the neutral refusal', async () => {
    const result = JSON.stringify({
      decided: true,
      results: [
        { index: 0, action: 'create', label: 'A', result: 'failed', code: 'some-future-code' },
        { index: 1, action: 'create', label: 'B', result: 'failed' },
        { index: 2, action: 'create', label: 'C', result: 'refused', code: 'some-future-code' },
      ],
    });
    await renderIn('pt-BR', { result });
    const line = (i: number) => screen.getByTestId(`team-front-proposal-result-${i}`).textContent;
    expect(line(0)).toBe('Falhou: A. Não foi possível gravar a mudança.');
    expect(line(1)).toBe('Falhou: B. Não foi possível gravar a mudança.');
    expect(line(2)).toBe('Não gravada: C. O Nimbalyst recusou esta mudança.');
  });
});

describe('a written item whose later step failed', () => {
  it('is shown as written, with its own warning, in both languages and without a raw key', async () => {
    const result = JSON.stringify({ decided: true, results: [{ index: 0, action: 'create', label: 'Billing', result: 'written', status: 'active', followUpWarning: 'Saved, but a step after saving failed: x' }] });
    await renderIn('pt-BR', { result });
    expect(screen.getByTestId('team-front-proposal-result-0').getAttribute('data-result')).toBe('written');
    expect(screen.getByTestId('team-front-proposal-result-0').textContent).toContain('Gravada: Billing (Ativa)');
    expect(screen.getByTestId('team-front-proposal-follow-up-warning').textContent).toBe('Gravada, mas uma etapa posterior não foi concluída.');
    expect(text()).not.toMatch(/teamFrontProposal\./);
    expect(text()).not.toContain('observer');
    cleanup();
    await renderIn('en', { result });
    expect(screen.getByTestId('team-front-proposal-follow-up-warning').textContent).toBe('Saved, but a step after saving did not complete.');
  });
});

describe('an unconfirmed result (advisor 49b904f1)', () => {
  const result = JSON.stringify({
    decided: true,
    results: [
      { index: 0, action: 'create', label: 'Billing', result: 'unconfirmed', id: 'tfr_9', code: 'write-unconfirmed', detail: 'English detail that must never be shown' },
      { index: 1, action: 'status', label: 'Portal', result: 'unconfirmed', id: 'tfr_1', code: 'write-unconfirmed' },
      { index: 2, action: 'create', label: 'Search', result: 'failed', code: 'write-failed' },
    ],
  });

  it('pt-BR: "Não confirmada", with the title and the Tracker, distinct from a failure; never the English detail', async () => {
    await renderIn('pt-BR', { result });
    expect(widget().getAttribute('data-state')).toBe('decided');
    expect(screen.getByTestId('team-front-proposal-result-0').getAttribute('data-result')).toBe('unconfirmed');
    expect(screen.getByTestId('team-front-proposal-result-0').textContent).toBe('Não confirmada: Billing. Confira o Rastreador.');
    expect(screen.getByTestId('team-front-proposal-result-1').textContent).toBe('Não confirmada: Portal. Confira o Rastreador.');
    expect(screen.getByTestId('team-front-proposal-result-2').textContent).toBe('Falhou: Search. Não foi possível gravar a mudança.');
    expect(text()).not.toContain('English detail');
    expect(text()).not.toMatch(/teamFrontProposal\./);
  });

  it('en: "Not confirmed"', async () => {
    await renderIn('en', { result });
    expect(screen.getByTestId('team-front-proposal-result-0').textContent).toBe('Not confirmed: Billing. Check the Tracker.');
    expect(screen.getAllByTestId('team-front-proposal-unconfirmed')).toHaveLength(2);
    expect(text()).not.toMatch(/teamFrontProposal\./);
  });

  it('a live decision answered with an unconfirmed item shows it the same way (no raw key)', async () => {
    for (const language of ['pt-BR', 'en'] as const) {
      await renderIn(language, { decide: { success: true, results: [{ index: 0, action: 'create', label: 'Billing', result: 'unconfirmed', id: 'tfr_9', code: 'write-unconfirmed', detail: 'English detail' }] } });
      await click('team-front-proposal-approve-all');
      await click('team-front-proposal-submit');
      expect(screen.getByTestId('team-front-proposal-unconfirmed')).toBeTruthy();
      expect(text()).not.toMatch(/teamFrontProposal\./);
      expect(text()).not.toContain('English detail');
      cleanup();
    }
  });
});
