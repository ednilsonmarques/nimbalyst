/**
 * A tracker type opened as a page in Pages mode (`type://<typeId>`), laid out
 * like a document tab: the crumb (where the type sits in the tree), the type's
 * name, one row of facts about the type, its prose (`TypePageProse`), then the
 * table of every item of the type (collab-client's `TypePageTable`).
 *
 * The table reads the same tracker atoms Tracker mode does and writes through
 * the same IPC paths, through the desktop tracker data source given to it.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { atom, useAtomValue, useStore, type Atom } from 'jotai';
import type { CollabScope } from '@nimbalyst/collab-client/core';
import type { SharedDocument } from '@nimbalyst/collab-client/docs';
import { DESKTOP_TRACKER_UI_CAPABILITIES, TrackersUIProvider } from '@nimbalyst/collab-client/trackers-ui';
import { TypePageTable, crumbItemLookup, trackerPageCrumbFolders, typePageTypeIds } from '@nimbalyst/collab-client/trackers-ui/page';
import '@nimbalyst/collab-client/trackers-ui/page.css';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { globalRegistry } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import { resolveColumnsForType } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import { trackerItemCountByTypeAtom, trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { ElectronTrackerDataSource } from '../../services/ElectronTrackerDataSource';
import {
  getElectronCollabDocsSession,
  getPersonalCollabHost,
  resolveDesktopCollabScope,
} from '../../store/atoms/collabDocuments';
import { createDesktopTrackerDataSource } from '../EmbedFrame/desktopTrackerDataSource';
import { useDesktopTrackerIdentity } from '../EmbedFrame/useDesktopTrackerIdentity';
import { isTeamTrackerSharing } from '../Settings/panels/trackerConfigUpgrade';
import { typePageTitle } from './collabPageTabs';
import { TypePageProse } from './TypePageProse';
import './TypePageTab.css';

type Lane = 'team' | 'personal';
interface TypePlacementRow { typeId: string; parentFolderId?: string | null; parentKind?: 'page' | 'item' }
interface ItemPlacementRow { itemId: string; parentId?: string | null; parentKind?: 'page' | 'item' }
interface PageRow { folderId: string; parentFolderId?: string | null; parentKind?: 'page' | 'item'; name: string }

const NO_TYPE_PLACEMENTS: Atom<readonly TypePlacementRow[]> = atom([]);
const NO_ITEM_PLACEMENTS: Atom<readonly ItemPlacementRow[]> = atom([]);
const NO_PAGES: Atom<readonly PageRow[]> = atom([]);
const NO_DOCUMENTS: Atom<readonly SharedDocument[]> = atom([]);

/** The section a type's page lives in: Personal types in Personal, team types in the team tree. */
function useTypePageScope(workspacePath: string, lane: Lane): CollabScope | null {
  const [teamScope, setTeamScope] = useState<CollabScope | null>(null);
  useEffect(() => {
    if (lane !== 'team') return;
    let cancelled = false;
    void resolveDesktopCollabScope(workspacePath).then(({ scope }) => {
      if (!cancelled) setTeamScope(scope);
    });
    return () => {
      cancelled = true;
    };
  }, [lane, workspacePath]);
  const personalScope = useMemo(
    () => (lane === 'personal' ? getPersonalCollabHost(workspacePath).scope : null),
    [lane, workspacePath],
  );
  return lane === 'personal' ? personalScope : teamScope;
}

/** The type's own field names, as the table heads them (title and tags aside). */
function typeFieldLabels(typeId: string): string[] {
  const model = globalRegistry.get(typeId);
  if (!model) return [];
  const own = new Set(model.fields.map((field) => field.name));
  return resolveColumnsForType(typeId)
    .filter((column) => own.has(column.id) && column.role !== 'title' && column.id !== 'tags')
    .map((column) => column.label);
}

export interface TypePageTabProps {
  typeId: string;
  workspacePath: string;
  /** Opens a row's item as a page tab in this mode. */
  onOpenItem: (itemId: string) => void;
}

export const TypePageTab: React.FC<TypePageTabProps> = ({ typeId, workspacePath, onOpenItem }) => {
  const { t } = useTranslation('team');
  const store = useStore();
  const identity = useDesktopTrackerIdentity(workspacePath);
  const writer = useMemo(() => new ElectronTrackerDataSource({ workspacePath }), [workspacePath]);
  useEffect(() => () => writer.dispose(), [writer]);
  const dataSource = useMemo(
    () => createDesktopTrackerDataSource({ workspacePath, store, writer }),
    [workspacePath, store, writer],
  );
  // `TrackerIdentity.email` is nullable; the provider's "me" needs one to stamp `by` on an edit.
  const trackerIdentity = identity?.email ? identity : null;

  const model = globalRegistry.get(typeId);
  const lane: Lane = model && isTeamTrackerSharing(model.sharing ?? 'personal') ? 'team' : 'personal';
  const typeName = typePageTitle(typeId);
  const scope = useTypePageScope(workspacePath, lane);
  const session = useMemo(() => (scope ? getElectronCollabDocsSession(scope) : null), [scope]);
  const typePlacements = useAtomValue<readonly TypePlacementRow[]>(session?.atoms.typePlacements ?? NO_TYPE_PLACEMENTS);
  const itemPlacements = useAtomValue<readonly ItemPlacementRow[]>(session?.atoms.itemPlacements ?? NO_ITEM_PLACEMENTS);
  // In the page tree every page can be a parent, and the session lists the pages here.
  const pages = useAtomValue<readonly PageRow[]>(session?.atoms.sharedFolders ?? NO_PAGES);
  const documents = useAtomValue<readonly SharedDocument[]>(session?.atoms.allSharedDocuments ?? NO_DOCUMENTS);
  // The type and every type that extends it: the tree row counts them all, so the table lists them all.
  const typeIds = useMemo(() => typePageTypeIds(typeId), [typeId, model]);
  const itemCountAtom = useMemo(
    () => atom((get) => typeIds.reduce((total, id) => total + get(trackerItemCountByTypeAtom(id)), 0)),
    [typeIds],
  );
  const itemCount = useAtomValue(itemCountAtom);

  // Typed-page titles above the type are read when the tree changes, not on every tracker edit.
  const itemLookup = useMemo(
    () => crumbItemLookup(store.get(trackerItemsMapAtom)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, typePlacements, itemPlacements, pages],
  );
  const crumb = useMemo(
    () => [...(lane === 'personal' ? [t('pages.personal')] : []), ...trackerPageCrumbFolders(typeId, typePlacements, pages, { itemPlacements, item: itemLookup })],
    [lane, typeId, typePlacements, pages, itemPlacements, itemLookup, t],
  );
  const parentFolderId = typePlacements.find((placement) => placement.typeId === typeId)?.parentFolderId ?? null;
  const fieldLabels = useMemo(() => typeFieldLabels(typeId), [typeId, model]);
  const itemTitle = useMemo(() => (itemId: string) => itemLookup(itemId)?.title ?? null, [itemLookup]);

  return (
    <div className="type-page-tab tracker-page-view flex h-full min-h-0 flex-col overflow-hidden bg-nim" data-testid="type-page-tab" data-type-id={typeId}>
      <div className="type-page-tab-scroller min-h-0 flex-1 overflow-y-auto">
        <div className="type-page-tab-column">
          <div className="tracker-page-view-header">
            <div className="tracker-page-view-crumb mb-2.5 truncate text-xs text-nim-faint select-text" data-testid="type-page-crumb">
              {crumb.map((part, index) => (
                <span key={`${index}:${part}`}>{part} / </span>
              ))}
              <span className="text-nim-muted">{typeName}</span>
            </div>
            <h1 className="type-page-tab-title m-0 mb-3 flex items-center gap-2 break-words text-[28px] font-medium leading-tight text-nim select-text">
              {model?.icon ? <MaterialSymbol icon={model.icon} size={26} style={{ color: model.color }} /> : null}
              {typeName}
            </h1>
            <div className="tracker-page-view-props flex flex-wrap items-center gap-x-[18px] gap-y-1.5 border-b border-nim pb-3 text-xs" data-testid="type-page-props">
              <span className="type-page-tab-type-chip inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-medium">
                <MaterialSymbol icon="table" size={13} />
                {t('pages.typePage.type')}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="text-nim-faint">{t('pages.typePage.pages')}</span>
                <span className="text-nim">{itemCount}</span>
              </span>
              {fieldLabels.length > 0 && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <span className="text-nim-faint">{t('pages.typePage.fields')}</span>
                  <span className="truncate text-nim">{fieldLabels.join(', ')}</span>
                </span>
              )}
            </div>
          </div>
          <TypePageProse
            key={typeId}
            typeId={typeId}
            typeName={typeName}
            itemName={model?.displayName || typeName}
            lane={lane}
            scope={scope}
            workspacePath={workspacePath}
            parentFolderId={parentFolderId}
            documents={documents}
          />
          <TrackersUIProvider dataSource={dataSource} identity={trackerIdentity} capabilities={DESKTOP_TRACKER_UI_CAPABILITIES}>
            <TypePageTable
              typeId={typeId}
              typeLabel={typeName}
              rootLabel={lane === 'personal' ? t('pages.personal') : t('pages.team')}
              itemPlacements={itemPlacements}
              pages={pages}
              itemTitle={itemTitle}
              onOpenItem={onOpenItem}
            />
          </TrackersUIProvider>
        </div>
      </div>
    </div>
  );
};
