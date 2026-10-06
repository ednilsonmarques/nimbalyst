/**
 * A typed page in Pages mode (`tracker://<id>` tab): the shared page layout
 * (collab-client's `TrackerPageView`) over the desktop's data.
 *
 * The body and field writes go through the same hooks as `TrackerItemDetail`
 * (`useTrackerItemBody`, `useTrackerItemFields`), so local and collaborative
 * bodies load, save and recover exactly as they do in Tracker mode. Links come
 * from the local relationship index over IPC.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { atom, useAtomValue, type Atom } from 'jotai';
import { selectAtom } from 'jotai/utils';
import { NimbalystEditor } from '@nimbalyst/runtime/editor';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import {
  TrackerPageView as SharedTrackerPageView,
  crumbItemLookup,
  legacyDescriptionToRecover,
  sameTrackerPageCrumb,
  trackerPageCrumb,
  type CrumbDocument,
  type CrumbFolder,
  type CrumbItemPlacement,
  type CrumbPlacement,
  type TrackerPageCrumb,
} from '@nimbalyst/collab-client/trackers-ui/page';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { TrackerReferenceSourceProvider } from '@nimbalyst/runtime/plugins/TrackerLinkPlugin';
import { resolveTrackerWriteAccess } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerLifecycle';
import { trackerItemByIdAtom, trackerDataLoadedAtom, trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { getElectronCollabDocsSession, getPersonalCollabDocsSession, resolveDesktopCollabScope } from '../../store/atoms/collabDocuments';
import { useMarkTrackerViewed } from '../../hooks/useTrackerUnread';
import { useRecordTrackerOpened } from '../../hooks/useRecordTrackerOpened';
import { isNativeItem } from './trackerContentMode';
import { useTrackerItemBody, useTrackerTeam } from './useTrackerItemBody';
import { useTrackerItemFields } from './useTrackerItemFields';
import { desktopPageLinksSource } from './TrackerLinksSection';
import { TrackerSavedDescription } from './TrackerSavedDescription';
import { createCollectionItem } from './createCollectionItem';
import { Trans, useTranslation } from '@nimbalyst/runtime/i18n/react';

// Moved to collab-client with the shared layout; re-exported for existing imports.
export { crumbItemLookup, legacyDescriptionToRecover, trackerPageCrumb, trackerPageCrumbFolders, type TrackerPageCrumb } from '@nimbalyst/collab-client/trackers-ui/page';

const NO_PLACEMENTS: Atom<readonly CrumbPlacement[]> = atom([]);
const NO_ITEM_PLACEMENTS: Atom<readonly CrumbItemPlacement[]> = atom([]);
const NO_FOLDERS: Atom<readonly CrumbFolder[]> = atom([]);
const NO_DOCUMENTS: Atom<readonly CrumbDocument[]> = atom([]);

/**
 * The team scope the crumb reads. The tab mounts once with whatever scope
 * Pages had at that moment, which can be none yet; resolve it here so the
 * crumb still reaches the team tree's live placements.
 */
function useTeamCrumbScope(workspacePath: string, collabScope: CollabScope | undefined, enabled: boolean): CollabScope | null {
  const [resolved, setResolved] = useState<CollabScope | null>(null);
  useEffect(() => {
    if (!enabled || collabScope) return;
    let cancelled = false;
    void resolveDesktopCollabScope(workspacePath).then(({ scope }) => {
      if (!cancelled) setResolved(scope);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, collabScope, workspacePath]);
  return collabScope ?? resolved;
}

/**
 * The page's crumb: Personal types read the workspace's Personal session,
 * team types the team session. The session's atoms carry every placement and
 * page change, so the crumb follows a move while the tab is open.
 */
function useTrackerPageCrumb(
  itemId: string,
  typeId: string,
  sharing: string,
  workspacePath: string,
  collabScope: CollabScope | undefined,
): TrackerPageCrumb & { section: string | null } {
  const { t } = useTranslation('tracker');
  const personal = sharing === 'personal';
  const teamScope = useTeamCrumbScope(workspacePath, collabScope, !personal);
  const session = useMemo(
    () => (personal ? getPersonalCollabDocsSession(workspacePath) : teamScope ? getElectronCollabDocsSession(teamScope) : null),
    [personal, workspacePath, teamScope],
  );
  // One derived atom: the crumb re-renders the page only when its names change,
  // not on every tracker item edit it reads titles from.
  const crumbAtom = useMemo(() => selectAtom(
    atom((get) => trackerPageCrumb(itemId, typeId, {
      itemPlacements: get<readonly CrumbItemPlacement[]>(session?.atoms.itemPlacements ?? NO_ITEM_PLACEMENTS),
      typePlacements: get<readonly CrumbPlacement[]>(session?.atoms.typePlacements ?? NO_PLACEMENTS),
      documents: get<readonly CrumbDocument[]>(session?.atoms.sharedDocuments ?? NO_DOCUMENTS),
      folders: get<readonly CrumbFolder[]>(session?.atoms.sharedFolders ?? NO_FOLDERS),
      item: crumbItemLookup(get(trackerItemsMapAtom)),
    })),
    (value) => value,
    sameTrackerPageCrumb,
  ), [itemId, typeId, session]);
  const crumb = useAtomValue(crumbAtom);
  return useMemo(() => ({ ...crumb, section: personal ? t('page.personal') : null }), [crumb, personal, t]);
}

export interface TrackerPageViewProps {
  itemId: string;
  workspacePath: string;
  /** Pages mode's team scope; the crumb reads team type placements from it. */
  collabScope?: CollabScope;
  /** Open another page (a link or a relationship chip). */
  onOpenItem?: (itemId: string) => void;
}

export const TrackerPageView: React.FC<TrackerPageViewProps> = ({
  itemId,
  workspacePath,
  collabScope,
  onOpenItem,
}) => {
  const { t } = useTranslation('tracker');
  const item = useAtomValue(trackerItemByIdAtom(itemId));
  const trackerDataLoaded = useAtomValue(trackerDataLoadedAtom);
  const model = useMemo(() => globalRegistry.get(item?.primaryType ?? ''), [item?.primaryType]);
  const referenceSource = useMemo(
    () => (item ? { itemId: item.id, type: item.primaryType } : null),
    [item?.id, item?.primaryType],
  );
  const [linksRevision, setLinksRevision] = useState(0);
  const bumpLinks = useCallback(() => setLinksRevision((r) => r + 1), []);
  const linksSource = useMemo(() => desktopPageLinksSource(workspacePath), [workspacePath]);
  // The body as last saved from this tab. The hook's `contentMarkdown` only
  // moves on load and on remote updates, so own edits are tracked here.
  const [savedBody, setSavedBody] = useState<string | null>(null);
  const handleContentSaved = useCallback((markdown: string) => {
    setSavedBody(markdown);
    bumpLinks();
  }, [bumpLinks]);

  useMarkTrackerViewed(item, workspacePath);
  useRecordTrackerOpened(item?.id, workspacePath);

  const { teamOrgId, teamMembers } = useTrackerTeam(workspacePath);
  const writeAccess = useMemo(() => resolveTrackerWriteAccess(model), [model]);
  // Pages hold native items; any other source keeps its fields read-only here.
  const editable = item ? isNativeItem(item) && writeAccess.canWrite : false;

  const body = useTrackerItemBody({
    itemId,
    item,
    workspacePath,
    teamOrgId,
    // A page is a full document surface: same block handles and selection
    // toolbar as every other editor tab.
    forceFloatingToolbar: true,
    onContentSaved: handleContentSaved,
  });
  // A load, a remote update, or switching pages supersedes the last own save.
  useEffect(() => setSavedBody(null), [body.contentMarkdown, itemId]);
  const { localTitle, storedValues, handleTextFieldChange, handleFieldChange } = useTrackerItemFields({
    itemId,
    item,
    editable,
    sharing: body.sharing,
    onRelationshipsReindexed: bumpLinks,
  });
  const handleRename = useCallback((title: string) => handleTextFieldChange('title', title), [handleTextFieldChange]);

  const crumb = useTrackerPageCrumb(itemId, item?.primaryType ?? '', body.sharing, workspacePath, collabScope);

  const handleCreateCollection = useCallback(
    (title: string, type: string) => createCollectionItem({ workspacePath, title, type }),
    [workspacePath],
  );

  const { contentMode, localEditorConfig, collabEditorConfig } = body;
  const currentBody = body.contentMarkdown === null ? null : savedBody ?? body.contentMarkdown;
  const savedDescription = item && body.hasRichContent ? legacyDescriptionToRecover(item.fields.description, currentBody) : null;

  const renderBody = () => {
    if (!item) return null;
    if (contentMode === 'local-pglite' && localEditorConfig) {
      return (
        <TrackerReferenceSourceProvider value={referenceSource}>
          <NimbalystEditor key={`${item.id}-${body.externalContentEpoch}`} config={localEditorConfig} />
        </TrackerReferenceSourceProvider>
      );
    }
    if (contentMode === 'collaborative' && collabEditorConfig) {
      return (
        <>
          {!body.hasSyncedOnce && (
            <div className="absolute inset-0 z-10 flex items-start justify-center bg-nim pt-6 pointer-events-none" data-testid="tracker-content-loading">
              <span className="text-sm text-nim-muted">{t('detail.loadingContent')}</span>
            </div>
          )}
          <TrackerReferenceSourceProvider value={referenceSource}>
            <NimbalystEditor key={`collab-${item.id}-${body.providerEpoch}`} config={collabEditorConfig} />
          </TrackerReferenceSourceProvider>
        </>
      );
    }
    if ((contentMode === 'local-pglite' || contentMode === 'collaborative') && !body.contentLoaded) {
      return <div className="tracker-page-view-gutter py-4 text-sm text-nim-faint">{t('common:loading')}</div>;
    }
    if (contentMode === 'collaborative' && body.collabLoading) {
      return <div className="tracker-page-view-gutter py-4 text-sm text-nim-faint">{t('detail.connecting')}</div>;
    }
    if (item.system.documentPath) {
      // File-backed pages keep their body in the file; Pages mode does not edit it.
      return (
        <div className="tracker-page-view-gutter py-4 text-sm text-nim-muted">
          <Trans t={t} i18nKey="page.bodyLivesIn" values={{ path: item.system.documentPath }} components={{ path: <span className="font-mono" /> }} />
        </div>
      );
    }
    return null;
  };

  return (
    <SharedTrackerPageView
      item={item ?? null}
      loaded={trackerDataLoaded}
      crumb={crumb}
      editable={editable}
      title={localTitle}
      onRename={handleRename}
      fieldValues={storedValues}
      onUpdateField={handleFieldChange}
      teamMembers={teamMembers}
      onCreateCollection={handleCreateCollection}
      renderBody={renderBody}
      beforeBody={item && savedDescription !== null ? (
        <div className="tracker-page-view-gutter">
          <TrackerSavedDescription
            key={item.id} description={savedDescription} currentBody={currentBody} editor={body.recoveryEditor}
            canInsert={editable && body.contentLoaded && (contentMode === 'local-pglite' || (contentMode === 'collaborative' && body.hasSyncedOnce && body.collabStatus === 'connected'))}
          />
        </div>
      ) : null}
      linksSource={linksSource}
      linksRevision={linksRevision}
      onOpenItem={onOpenItem}
    />
  );
};
