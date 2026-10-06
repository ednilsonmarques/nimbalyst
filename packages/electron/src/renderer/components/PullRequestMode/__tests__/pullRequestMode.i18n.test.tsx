// @vitest-environment jsdom
/**
 * The GitHub panel (PR review + issues) follows the UI language: English stays
 * identical to the original literals, pt-BR renders translated text (never a
 * raw key), plurals/relative times resolve, and GitHub-sourced values (titles,
 * branches, logins) are never touched.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { I18nProvider } from '@nimbalyst/runtime/i18n/react';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import type { PullRequestRow as PullRequestRowData } from '../../../services/RendererPullRequestService';
import type { GithubIssueRow as GithubIssueRowData } from '../../../services/RendererGithubIssueService';

const permissions = vi.hoisted(() => vi.fn());
const timeline = vi.hoisted(() => vi.fn());

vi.mock('../../../services/RendererGhCliService', () => ({
  getGhCliService: () => ({
    getStatus: () => new Promise(() => {}),
    onStatusChanged: () => () => {},
    refreshStatus: vi.fn(),
  }),
}));
vi.mock('../../../services/RendererPullRequestService', () => ({
  getPullRequestService: () => ({ permissions, approve: vi.fn(), merge: vi.fn() }),
}));
vi.mock('../../../services/RendererGithubIssueService', () => ({
  getGithubIssueService: () => ({ timeline }),
}));
vi.mock('../PrTrackerStrip', () => ({ PrTrackerStrip: () => null }));
vi.mock('../tabs/ConversationTab', () => ({ ConversationTab: () => null }));
vi.mock('../tabs/FilesChangedTab', () => ({ FilesChangedTab: () => null }));
vi.mock('../tabs/CommitsTab', () => ({ CommitsTab: () => null }));
vi.mock('../tabs/ChecksTab', () => ({ ChecksTab: () => null }));

const { GhOnboardingBanner } = await import('../GhOnboardingBanner');
const { PullRequestDetail } = await import('../PullRequestDetail');
const { PullRequestRow } = await import('../PullRequestRow');
const { PullRequestActionError, GH_WORKFLOW_SCOPE_REFRESH_COMMAND } = await import('../PullRequestActionError');
const { InlineFileDiff } = await import('../PrFileDiff');
const { GithubIssueRow } = await import('../issues/GithubIssueRow');
const { formatRelative, buildPrContextItem, buildReviewContributionDraft } = await import('../prFormat');
const { buildIssueContextItem } = await import('../issues/issueFormat');
const { IssueActivityTab } = await import('../issues/tabs/IssueActivityTab');

const RAW_KEY = /\b(onboarding|common|list|sort|time|shell|diff|trackerStrip|actions|detail|prState|prRow|prFilters|prList|prEmpty|checks|commits|conversation|files|issues)\.[\w.-]+/;

afterEach(async () => {
  cleanup();
  permissions.mockReset();
  await setLanguage('en');
});

async function inLanguage(language: 'en' | 'pt-BR'): Promise<void> {
  await act(async () => {
    await setLanguage(language);
  });
}

function wrap(node: React.ReactElement) {
  return render(<I18nProvider>{node}</I18nProvider>);
}

const pr: PullRequestRowData = {
  id: 'pr-809',
  workspaceId: '/workspace',
  remote: 'nimbalyst/nimbalyst',
  number: 809,
  title: 'Add PR review sessions',
  body: null,
  state: 'open',
  isDraft: true,
  authorLogin: 'reviewer',
  authorAvatarUrl: null,
  headRef: 'feature/review-session',
  headSha: 'abc123',
  baseRef: 'main',
  mergeable: 'mergeable',
  commentsCount: 0,
  reviewCommentsCount: 0,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  ciStatus: 'success',
  reviewers: [],
  labels: [],
  raw: { html_url: 'https://github.com/nimbalyst/nimbalyst/pull/809' },
  etag: null,
  createdAt: 1,
  updatedAt: Date.now(),
  fetchedAt: 1,
};

const issue: GithubIssueRowData = {
  id: 'issue-42',
  workspacePath: '/workspace',
  remote: 'nimbalyst/nimbalyst',
  number: 42,
  title: 'Crash when opening settings',
  body: null,
  state: 'closed',
  stateReason: 'not_planned',
  authorLogin: 'octocat',
  authorAvatarUrl: null,
  assignees: [],
  labels: [],
  commentsCount: 1,
  locked: false,
  htmlUrl: 'https://github.com/nimbalyst/nimbalyst/issues/42',
  milestone: null,
  raw: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  closedAt: null,
  fetchedAt: 1,
};

describe('GhOnboardingBanner i18n', () => {
  it('keeps the English copy identical', async () => {
    await inLanguage('en');
    wrap(<GhOnboardingBanner initialStatus={{ installed: false, authed: false } as never} onDismiss={() => {}} />);
    screen.getByText('GitHub CLI is required');
    screen.getByText('Install gh');
    screen.getByText('Recheck');
    expect(screen.getByRole('status').textContent).toContain('CLI for all GitHub access. Nimbalyst stores no tokens.');
    expect(screen.getByLabelText('Dismiss')).toBeTruthy();
  });

  it('renders pt-BR for the not-installed and sign-in states', async () => {
    await inLanguage('pt-BR');
    const { unmount } = wrap(<GhOnboardingBanner initialStatus={{ installed: false, authed: false } as never} onDismiss={() => {}} />);
    screen.getByText('O GitHub CLI é necessário');
    screen.getByText('Instalar gh');
    screen.getByText('Verificar novamente');
    expect(screen.getByLabelText('Dispensar')).toBeTruthy();
    // The `gh` command stays a <code> element inside the translated sentence.
    expect(screen.getByRole('status').querySelector('code')?.textContent).toBe('gh');
    expect(screen.getByRole('status').textContent).not.toMatch(RAW_KEY);
    unmount();

    wrap(<GhOnboardingBanner initialStatus={{ installed: true, authed: false } as never} />);
    screen.getByText('Entrar no GitHub');
    screen.getByText('Copiar');
    expect(screen.getByTitle('Copiar comando')).toBeTruthy();
    // The command itself is never translated.
    screen.getByText('gh auth login');
  });
});

describe('PullRequestDetail i18n', () => {
  function renderDetail() {
    permissions.mockReturnValue(new Promise(() => {}));
    return wrap(
      <PullRequestDetail
        workspaceId="/workspace"
        remote="nimbalyst/nimbalyst"
        pr={pr}
        onClose={() => undefined}
        onStartReviewSession={() => undefined}
        onOpenInWorktree={() => undefined}
        trackerContext={{ items: [], primary: null, sessions: [] }}
      />,
    );
  }

  it('keeps the English tabs and header actions', async () => {
    await inLanguage('en');
    renderDetail();
    expect(screen.getByTestId('pr-tab-conversation').textContent).toBe('Conversation');
    expect(screen.getByTestId('pr-tab-files').textContent).toBe('Files Changed');
    expect(screen.getByTestId('pr-tab-checks').textContent).toBe('Checks');
    expect(screen.getByTestId('pr-start-review-session').textContent).toContain('Review with AI');
    expect(screen.getByTestId('pr-start-review-session').getAttribute('title')).toBe('Review #809 with AI');
    expect(screen.getByTestId('pr-open-in-worktree').textContent).toContain('Open in Worktree');
    expect(screen.getByTitle('Open on GitHub')).toBeTruthy();
  });

  it('translates tabs and actions to pt-BR without touching PR data', async () => {
    await inLanguage('pt-BR');
    renderDetail();
    expect(screen.getByTestId('pr-tab-conversation').textContent).toBe('Conversa');
    expect(screen.getByTestId('pr-tab-files').textContent).toBe('Arquivos alterados');
    expect(screen.getByTestId('pr-tab-checks').textContent).toBe('Verificações');
    expect(screen.getByTestId('pr-start-review-session').textContent).toContain('Revisar com IA');
    expect(screen.getByTestId('pr-start-review-session').getAttribute('title')).toBe('Revisar #809 com IA');
    expect(screen.getByTestId('pr-open-in-worktree').getAttribute('title')).toBe('Criar um worktree no branch deste PR');
    expect(screen.getByTitle('Abrir no GitHub')).toBeTruthy();
    screen.getByText('Add PR review sessions');
    screen.getByText('main ← feature/review-session');
    expect(screen.getByTestId('pr-detail').textContent).not.toMatch(RAW_KEY);
  });
});

describe('PullRequestActions i18n', () => {
  it('translates merge method labels and the confirm step', async () => {
    permissions.mockResolvedValue({
      viewerLogin: 'me',
      canApprove: true,
      canMerge: true,
      mergeMethods: { squash: true, merge: false, rebase: false },
      mergeable: true,
      mergeableState: 'clean',
      state: 'open',
      isDraft: false,
    });
    const { PullRequestActions } = await import('../PullRequestActions');
    await inLanguage('pt-BR');
    wrap(
      <PullRequestActions
        workspaceId="/workspace"
        remote="nimbalyst/nimbalyst"
        pr={{ ...pr, isDraft: false }}
        refreshToken={0}
        onActed={() => {}}
      />,
    );
    const merge = await screen.findByTestId('pr-merge-button');
    expect(merge.textContent).toContain('Squash e mesclar');
    expect(merge.getAttribute('title')).toBe('Mesclar #809 em main');
    expect(screen.getByTestId('pr-approve-button').textContent).toContain('Aprovar');
    fireEvent.click(merge);
    const confirm = screen.getByTestId('pr-merge-confirm');
    expect(confirm.textContent).toContain('Squash e mesclar em main?');
    expect(confirm.querySelector('.font-mono')?.textContent).toBe('main');
    expect(screen.getByTestId('pr-merge-confirm-button').textContent).toContain('Confirmar');
    expect(screen.getByTestId('pr-merge-cancel-button').textContent).toBe('Cancelar');
  });

  it('keeps the English confirm sentence identical', async () => {
    permissions.mockResolvedValue({
      viewerLogin: 'me',
      canApprove: false,
      canMerge: true,
      mergeMethods: { squash: false, merge: false, rebase: true },
      mergeable: true,
      mergeableState: 'clean',
      state: 'open',
      isDraft: false,
    });
    const { PullRequestActions } = await import('../PullRequestActions');
    await inLanguage('en');
    wrap(
      <PullRequestActions
        workspaceId="/workspace"
        remote="nimbalyst/nimbalyst"
        pr={{ ...pr, isDraft: false }}
        refreshToken={0}
        onActed={() => {}}
      />,
    );
    const merge = await screen.findByTestId('pr-merge-button');
    expect(merge.textContent).toContain('Rebase and merge');
    fireEvent.click(merge);
    expect(screen.getByTestId('pr-merge-confirm').textContent).toContain('Rebase and merge into main?');
  });
});

describe('PullRequestRow / GithubIssueRow i18n', () => {
  it('renders the draft badge and relative time per language', async () => {
    await inLanguage('en');
    const { unmount } = wrap(<PullRequestRow pr={pr} selected={false} onSelect={() => {}} hasSessions />);
    screen.getByText('Draft');
    screen.getByText('just now');
    expect(screen.getByTitle('Has linked review sessions')).toBeTruthy();
    unmount();

    await inLanguage('pt-BR');
    wrap(<PullRequestRow pr={pr} selected={false} onSelect={() => {}} hasSessions />);
    screen.getByText('Rascunho');
    screen.getByText('agora');
    expect(screen.getByTitle('Tem sessões de revisão vinculadas')).toBeTruthy();
    screen.getByText('feature/review-session');
  });

  it('translates issue state, comment-count plural and tooltips', async () => {
    await inLanguage('pt-BR');
    const { unmount } = wrap(<GithubIssueRow issue={issue} selected={false} onSelect={() => {}} />);
    screen.getByText('Não planejada');
    expect(screen.getByTitle('1 comentário')).toBeTruthy();
    expect(screen.getByTitle('Última atividade')).toBeTruthy();
    screen.getByText('Crash when opening settings');
    unmount();

    wrap(<GithubIssueRow issue={{ ...issue, commentsCount: 3 }} selected={false} onSelect={() => {}} />);
    expect(screen.getByTitle('3 comentários')).toBeTruthy();
  });

  it('keeps the English issue row copy identical', async () => {
    await inLanguage('en');
    wrap(<GithubIssueRow issue={issue} selected={false} onSelect={() => {}} />);
    screen.getByText('Not planned');
    expect(screen.getByTitle('1 comments')).toBeTruthy();
    expect(screen.getByTitle('Last activity')).toBeTruthy();
  });
});

describe('formatRelative i18n', () => {
  const DAY = 24 * 60 * 60 * 1000;

  it('keeps the compact English forms', async () => {
    await inLanguage('en');
    expect(formatRelative(Date.now() - 5 * 60 * 1000)).toBe('5m ago');
    expect(formatRelative(Date.now() - 3 * 60 * 60 * 1000)).toBe('3h ago');
    expect(formatRelative(Date.now() - 4 * DAY)).toBe('4d ago');
    expect(formatRelative(Date.now() - 65 * DAY)).toBe('2mo ago');
    expect(formatRelative(Date.now() - 400 * DAY)).toBe('1y ago');
  });

  it('renders pt-BR with plural months/years', async () => {
    await inLanguage('pt-BR');
    expect(formatRelative(Date.now() - 10 * 1000)).toBe('agora');
    expect(formatRelative(Date.now() - 5 * 60 * 1000)).toBe('há 5 min');
    expect(formatRelative(Date.now() - 4 * DAY)).toBe('há 4 d');
    expect(formatRelative(Date.now() - 35 * DAY)).toBe('há 1 mês');
    expect(formatRelative(Date.now() - 65 * DAY)).toBe('há 2 meses');
    expect(formatRelative(Date.now() - 400 * DAY)).toBe('há 1 ano');
    expect(formatRelative(Date.now() - 800 * DAY)).toBe('há 2 anos');
  });
});

describe('PullRequestActionError / InlineFileDiff i18n', () => {
  it('translates the recovery button but keeps the raw error and command', async () => {
    await inLanguage('pt-BR');
    const error = `refusing to allow an OAuth App to create or update workflow. Run: ${GH_WORKFLOW_SCOPE_REFRESH_COMMAND}`;
    wrap(<PullRequestActionError error={error} />);
    expect(screen.getByTestId('pr-copy-workflow-scope-command').textContent).toBe('Copiar comando');
    expect(screen.getByRole('alert').textContent).toContain(error);
  });

  it('translates the empty-diff message', async () => {
    await inLanguage('pt-BR');
    const { unmount } = wrap(<InlineFileDiff filePath="a.ts" unifiedDiff={null} />);
    screen.getByText('Nenhuma alteração textual para exibir neste arquivo.');
    unmount();

    await inLanguage('en');
    wrap(<InlineFileDiff filePath="a.ts" unifiedDiff={null} />);
    screen.getByText('No textual changes to display for this file.');
  });
});

describe('AI-bound text stays English', () => {
  it('does not translate PR/issue context cards or the review draft in pt-BR', async () => {
    await inLanguage('pt-BR');
    const prItem = buildPrContextItem('nimbalyst/nimbalyst', pr);
    expect(prItem.label).toBe('PR #809');
    expect(prItem.description).toContain('Pull request: #809 Add PR review sessions');
    expect(prItem.description).toContain('Draft: yes');
    const issueItem = buildIssueContextItem('nimbalyst/nimbalyst', issue);
    expect(issueItem.label).toBe('Issue #42');
    expect(issueItem.description).toContain('State: closed as not planned');
    expect(issueItem.description).toContain('Body excerpt (untrusted');
    const draft = buildReviewContributionDraft('nimbalyst/nimbalyst', 809);
    expect(draft).toContain('This is a read-only review.');
    expect(draft).not.toMatch(/revis|leitura/i);
  });
});

describe('IssueActivityTab event labels', () => {
  const events = [
    { issueId: 'issue-42', id: 'e1', event: 'labeled', actorLogin: 'octocat', actorAvatarUrl: null, raw: null, createdAt: Date.now(), fetchedAt: 1 },
    { issueId: 'issue-42', id: 'e2', event: 'head_ref_deleted', actorLogin: 'octocat', actorAvatarUrl: null, raw: null, createdAt: Date.now(), fetchedAt: 1 },
  ];

  async function renderTab(language: 'en' | 'pt-BR') {
    timeline.mockResolvedValue(events);
    await inLanguage(language);
    wrap(<IssueActivityTab workspaceId="/workspace" remote="nimbalyst/nimbalyst" issue={issue} refreshToken={0} />);
    await screen.findByText('head ref deleted');
  }

  it('translates known events and falls back to the raw event name', async () => {
    await renderTab('pt-BR');
    screen.getByText('adicionou o rótulo');
    expect(screen.getByTestId('issue-activity-tab').textContent).not.toMatch(RAW_KEY);
  });

  it('keeps the English event names identical', async () => {
    await renderTab('en');
    screen.getByText('labeled');
  });
});
