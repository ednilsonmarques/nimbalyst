/**
 * Pages mode's left sidebar: the Team section over the Personal section, each
 * a `CollabSidebar` bound to its own docs session. With no team scope the
 * Personal section stands alone under a one-line note.
 */

import React, { useState } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import type { PageTypeLane } from '@nimbalyst/collab-client/docs/pageTypes';
import { CollabSidebar, type CollabSidebarCreateMenu } from '@nimbalyst/collab-client/docs-ui';
import { SetPageTypeDialog } from '@nimbalyst/collab-client/docs-ui/setPageType';
import {
  getElectronCollabDocsSession,
  getPersonalCollabDocsSession,
  type SharedDocument,
} from '../../store/atoms/collabDocuments';
import { ElectronCollabDocsUIRoot } from './ElectronCollabDocsUIProvider';
import { useCollabTypeResolver } from './useCollabTypeResolver';
import { useSetPageType } from './useSetPageType';
import { usePagesSidebarCollapse } from './usePagesSidebarCollapse';

interface PagesSidebarSectionsProps {
  workspacePath: string;
  teamScope: CollabScope | null;
  personalScope: CollabScope;
  activeTeamDocumentId: string | null;
  activePersonalDocumentId: string | null;
  /** The open typed page or type; either section marks it if its tree holds it. */
  activeRow: { itemId: string | null; typeId: string | null };
  onShowHome: () => void;
  homeActive: boolean;
  registerTeamCreateMenu: (menu: CollabSidebarCreateMenu | null) => void;
  registerPersonalCreateMenu: (menu: CollabSidebarCreateMenu | null) => void;
}

export function PagesSidebarSections({
  workspacePath,
  teamScope,
  personalScope,
  activeTeamDocumentId,
  activePersonalDocumentId,
  activeRow,
  onShowHome,
  homeActive,
  registerTeamCreateMenu,
  registerPersonalCreateMenu,
}: PagesSidebarSectionsProps) {
  const { t } = useTranslation('team');
  const teamTypeResolver = useCollabTypeResolver('team');
  const personalTypeResolver = useCollabTypeResolver('personal');
  const setPageType = useSetPageType(workspacePath, teamScope);
  const [typingPage, setTypingPage] = useState<{ lane: PageTypeLane; page: SharedDocument } | null>(null);
  const { collapsed, toggle } = usePagesSidebarCollapse(workspacePath, teamScope !== null);
  // Open sections share the height; a collapsed one keeps only its header row.
  const sectionClass = (isCollapsed: boolean) => (isCollapsed ? 'shrink-0' : 'flex-1 min-h-0');

  const pickType = (typeId: string) => {
    if (!typingPage) return;
    const { lane, page } = typingPage;
    const session = lane === 'personal'
      ? getPersonalCollabDocsSession(workspacePath)
      : teamScope ? getElectronCollabDocsSession(teamScope) : null;
    if (!session) return;
    void setPageType.run(lane, session, page, typeId)
      .finally(() => setTypingPage(null));
  };

  return (
    <div className="pages-sidebar-sections flex flex-col h-full min-h-0">
      {teamScope ? (
        <div className={`pages-sidebar-team-section ${sectionClass(collapsed.team)}`}>
          {/* No Feedback action here any more: the request list is an
              organization surface, not a shared-docs one, and it moved beside
              the Inbox in Org mode (#3704). A document's own feedback still
              reaches it through the per-artifact backlinks. */}
          <ElectronCollabDocsUIRoot scope={teamScope}>
            <CollabSidebar
              sectionTitle={t('pages.team')}
              activeDocumentId={activeTeamDocumentId}
              activeItemId={activeRow.itemId}
              activeTypeId={activeRow.typeId}
              onShowHome={onShowHome}
              homeActive={homeActive}
              registerCreateMenu={registerTeamCreateMenu}
              typeResolver={teamTypeResolver}
              collapsed={collapsed.team}
              onToggleCollapsed={() => toggle('team')}
              onSetPageType={(page) => setTypingPage({ lane: 'team', page })}
            />
          </ElectronCollabDocsUIRoot>
        </div>
      ) : (
        <div
          className="pages-sidebar-team-note px-3 py-2 text-xs text-nim-faint bg-nim-secondary border-r border-b border-nim shrink-0"
          data-testid="pages-sidebar-team-note"
        >
          {t('pages.signInForTeamPages')}
        </div>
      )}
      <div className={`pages-sidebar-personal-section ${sectionClass(collapsed.personal)}`}>
        <ElectronCollabDocsUIRoot scope={personalScope}>
          <CollabSidebar
            sectionTitle={t('pages.personal')}
            activeDocumentId={activePersonalDocumentId}
            activeItemId={activeRow.itemId}
            activeTypeId={activeRow.typeId}
            registerCreateMenu={registerPersonalCreateMenu}
            typeResolver={personalTypeResolver}
            collapsed={collapsed.personal}
            onToggleCollapsed={() => toggle('personal')}
            onSetPageType={(page) => setTypingPage({ lane: 'personal', page })}
          />
        </ElectronCollabDocsUIRoot>
      </div>
      {typingPage && (
        <SetPageTypeDialog
          pageTitle={typingPage.page.title}
          resolver={typingPage.lane === 'team' ? teamTypeResolver : personalTypeResolver}
          running={setPageType.running}
          onPick={pickType}
          onClose={() => setTypingPage(null)}
        />
      )}
    </div>
  );
}
