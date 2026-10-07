/**
 * AgentTeamView - Agent mode "Team" view (alpha flag `agent-team-view`).
 *
 * A read-only projection of state the app already has: sessions come from
 * sessionRegistryAtom, edges from SessionMeta.createdBySessionId, live status
 * from the per-session atoms (inside AgentTeamNode), worktree branch from
 * teamDataSource. Nothing here writes session state; clicking a node hands the
 * id to the same select action the kanban board uses.
 */

import React, { useMemo, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import { alphaFeatureEnabledAtom } from '../../store/atoms/appSettings';
import { buildTeamForest, countTeamNodes, isTeamCandidate, type TeamTreeNode } from './agentTeamGraph';
import { AgentTeamNode } from './AgentTeamNode';
import { useTeamWorktrees } from './useTeamWorktrees';
import type { TeamWorktreeInfo } from './teamDataSource';
import './AgentTeamView.css';

const STANDALONE_PREVIEW_COUNT = 24;

export interface AgentTeamViewProps {
  onSessionOpen: (sessionId: string) => void;
}

/**
 * AgentMode only routes here when the flag is on; the guard keeps the view inert
 * if it is ever mounted elsewhere with the flag off.
 */
export function AgentTeamView({ onSessionOpen }: AgentTeamViewProps) {
  const enabled = useAtomValue(alphaFeatureEnabledAtom('agent-team-view'));
  if (!enabled) return null;
  return <AgentTeamBoard onSessionOpen={onSessionOpen} />;
}

function AgentTeamBoard({ onSessionOpen }: { onSessionOpen: (sessionId: string) => void }) {
  const { t } = useTranslation('agent');
  const registry = useAtomValue(sessionRegistryAtom);
  const [showAllStandalone, setShowAllStandalone] = useState(false);

  const forest = useMemo(() => buildTeamForest(registry.values()), [registry]);
  const worktreeIds = useMemo(() => {
    const ids: string[] = [];
    for (const session of registry.values()) {
      if (session.worktreeId && isTeamCandidate(session)) ids.push(session.worktreeId);
    }
    return ids;
  }, [registry]);
  const worktrees = useTeamWorktrees(worktreeIds);

  const { teams, standalone } = forest;
  const visibleStandalone = showAllStandalone ? standalone : standalone.slice(0, STANDALONE_PREVIEW_COUNT);

  if (teams.length === 0 && standalone.length === 0) {
    return (
      <div className="agent-team-view flex h-full items-center justify-center text-sm text-[var(--nim-text-muted)]" data-testid="agent-team-view">
        {t('agentTeam.emptyAll')}
      </div>
    );
  }

  return (
    <div className="agent-team-view h-full overflow-auto bg-[var(--nim-bg)]" data-testid="agent-team-view">
      <div className="px-6 py-4">
        <header className="mb-4">
          <h2 className="m-0 flex items-center gap-2 text-base font-semibold text-[var(--nim-text)]">
            <MaterialSymbol icon="account_tree" size={18} />
            {t('agentTeam.title')}
          </h2>
          <p className="m-0 mt-1 text-xs text-[var(--nim-text-muted)]">{t('agentTeam.subtitle')}</p>
        </header>

        <section className="agent-team-teams mb-8" data-testid="agent-team-teams">
          <h3 className="m-0 mb-3 text-xs font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">
            {t('agentTeam.teamsHeading', { total: teams.length })}
          </h3>
          {teams.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--nim-border)] px-4 py-6 text-center" data-testid="agent-team-empty-teams">
              <p className="m-0 text-sm text-[var(--nim-text)]">{t('agentTeam.emptyTeamsTitle')}</p>
              <p className="m-0 mt-1 text-xs text-[var(--nim-text-muted)]">{t('agentTeam.emptyTeamsHint')}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              {teams.map((root) => (
                <div
                  key={root.session.id}
                  className="agent-team-tree-card overflow-x-auto rounded-md border border-[var(--nim-border)] p-4"
                  data-testid={`agent-team-tree-${root.session.id}`}
                >
                  <div className="mb-2 text-[11px] text-[var(--nim-text-faint)]">
                    {t('agentTeam.agentCount', { total: countTeamNodes(root) })}
                  </div>
                  <div className="agent-team-tree flex w-max min-w-full flex-col items-center">
                    <TeamTreeBranch node={root} worktrees={worktrees} onOpen={onSessionOpen} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {standalone.length > 0 && (
          <section className="agent-team-standalone" data-testid="agent-team-standalone">
            <h3 className="m-0 text-xs font-semibold uppercase tracking-wide text-[var(--nim-text-muted)]">
              {t('agentTeam.standaloneHeading', { total: standalone.length })}
            </h3>
            <p className="m-0 mb-3 mt-1 text-xs text-[var(--nim-text-faint)]">{t('agentTeam.standaloneHint')}</p>
            <div className="flex flex-wrap gap-3">
              {visibleStandalone.map((session) => (
                <AgentTeamNode
                  key={session.id}
                  session={session}
                  worktree={session.worktreeId ? worktrees.get(session.worktreeId) : undefined}
                  onOpen={onSessionOpen}
                />
              ))}
            </div>
            {standalone.length > STANDALONE_PREVIEW_COUNT && (
              <button
                type="button"
                className="mt-3 cursor-pointer border-none bg-transparent p-0 text-xs text-[var(--nim-primary)] hover:underline"
                data-testid="agent-team-standalone-toggle"
                onClick={() => setShowAllStandalone((value) => !value)}
              >
                {showAllStandalone
                  ? t('agentTeam.showFewerStandalone')
                  : t('agentTeam.showAllStandalone', { total: standalone.length })}
              </button>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function TeamTreeBranch({
  node,
  worktrees,
  onOpen,
}: {
  node: TeamTreeNode;
  worktrees: Map<string, TeamWorktreeInfo>;
  onOpen: (sessionId: string) => void;
}) {
  const { session } = node;
  return (
    <>
      <AgentTeamNode
        session={session}
        worktree={session.worktreeId ? worktrees.get(session.worktreeId) : undefined}
        creatorOutsideView={node.creatorOutsideView}
        onOpen={onOpen}
      />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <li key={child.session.id}>
              <TeamTreeBranch node={child} worktrees={worktrees} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
