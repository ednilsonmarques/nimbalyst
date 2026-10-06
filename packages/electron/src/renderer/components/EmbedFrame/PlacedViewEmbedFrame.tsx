/**
 * The desktop renderer for a view placed in a page
 * (a placed-view link alone on its line, see `placedViewUrl.ts`).
 *
 * It brings its own `TrackersUIProvider` because a document tab has none; the
 * data source reads the tracker atoms the listeners already keep current (no
 * second item load), and a cell edit writes through the same IPC paths as
 * Tracker mode, so editing a cell edits the item it points at. A marks list
 * reads the page-marks source the host installs at startup.
 *
 * Those items are this window's project's, so a view whose link names another
 * scope (another team project, or a `local` view on a team page) is never
 * drawn from them or edited through them: `PlacedViewEmbed` shows its link
 * instead, which the console link router opens.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useStore } from 'jotai';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import type { PlacedViewTarget } from '@nimbalyst/runtime/core/placedViewUrl';
import { DESKTOP_TRACKER_UI_CAPABILITIES, TrackersUIProvider } from '@nimbalyst/collab-client/trackers-ui';
import { PlacedViewEmbed, PlacedViewNote } from '@nimbalyst/collab-client/trackers-ui/embed';
import { ElectronTrackerDataSource } from '../../services/ElectronTrackerDataSource';
import { activeWorkspacePathAtom } from '../../store/atoms/openProjects';
import { activeCollabScopeAtom } from '../../store/atoms/collabDocuments';
import { navigateToTrackerItem } from '../PullRequestMode/trackerNavigation';
import { openAgentEditedPage } from '../../utils/agentEditedPage';
import { createDesktopTrackerDataSource } from './desktopTrackerDataSource';
import { useDesktopTrackerIdentity } from './useDesktopTrackerIdentity';
import { windowPlacedViewReach } from './placedViewCommands';

export interface PlacedViewEmbedFrameProps {
  target: PlacedViewTarget;
  label: string;
  attrs: Record<string, string>;
}

export const PlacedViewEmbedFrame: React.FC<PlacedViewEmbedFrameProps> = (props) => {
  const { t } = useTranslation('team');
  const workspacePath = useAtomValue(activeWorkspacePathAtom);
  if (!workspacePath) {
    return <PlacedViewNote>{t('embed.placedView.openProject', { label: props.label || t('embed.placedView.view') })}</PlacedViewNote>;
  }
  return <WorkspacePlacedView workspacePath={workspacePath} {...props} />;
};

const WorkspacePlacedView: React.FC<PlacedViewEmbedFrameProps & { workspacePath: string }> = ({
  workspacePath,
  target,
  label,
  attrs,
}) => {
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
  // A listed mark opens the page it is on, in Pages mode.
  const openPage = useCallback((uri: string) => {
    void openAgentEditedPage(uri, workspacePath).catch((error) => console.warn('[PlacedViewEmbedFrame] could not open page', uri, error));
  }, [workspacePath]);
  // The page this embed is on decides whether a `local` view reaches these items.
  const anchorRef = useRef<HTMLDivElement>(null);
  const [pagePath, setPagePath] = useState<string | null | undefined>(undefined);
  useLayoutEffect(() => {
    setPagePath(anchorRef.current?.closest('[data-file-path]')?.getAttribute('data-file-path') ?? null);
  }, []);
  // Re-read the reach when the window's team changes.
  const collabScope = useAtomValue(activeCollabScopeAtom);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reach = useMemo(() => (pagePath === undefined ? undefined : windowPlacedViewReach(pagePath)), [pagePath, collabScope]);
  return (
    <div ref={anchorRef} className="placed-view-embed-frame">
      {reach ? (
        <TrackersUIProvider dataSource={dataSource} identity={trackerIdentity} capabilities={DESKTOP_TRACKER_UI_CAPABILITIES}>
          <PlacedViewEmbed
            target={target}
            label={label}
            attrs={attrs}
            reach={reach}
            onOpenItem={navigateToTrackerItem}
            onOpenPage={openPage}
            onOpenLink={openLink}
          />
        </TrackersUIProvider>
      ) : null}
    </div>
  );
};

/** Through the console link router: in this window when it holds the target, else the browser. */
const openLink = (href: string) => {
  void window.electronAPI.openExternal(href).catch((error: unknown) => console.warn('[PlacedViewEmbedFrame] could not open view link', href, error));
};
