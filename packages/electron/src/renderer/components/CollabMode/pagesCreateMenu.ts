/**
 * The title bar's "+" menu for Pages mode, composed from the Team and Personal
 * sidebar sections. The title bar holds one menu per mode, so the Personal
 * section's entries join the team menu rather than publishing their own.
 */

import type { CollabSidebarCreateMenu } from '@nimbalyst/collab-client/docs-ui';
import type { TitleBarCreateMenu } from '../../store/atoms/titleBarCreate';
import { t as translate } from '@nimbalyst/runtime/i18n';

export function composePagesCreateMenu(
  team: CollabSidebarCreateMenu | null,
  personal: CollabSidebarCreateMenu | null,
): TitleBarCreateMenu | null {
  const primary = team ?? personal;
  if (!primary) return null;
  const folderItem = (menu: CollabSidebarCreateMenu, id: string, label: string) => ({
    id,
    label,
    icon: 'create_new_folder',
    separatorBefore: true,
    onSelect: menu.onNewFolder,
  });

  // A page tree has no folders: a folder is a page with an empty body.
  const folderItems = (menu: CollabSidebarCreateMenu, id: string, label: string) =>
    (menu.pageTree ? [] : [folderItem(menu, id, label)]);

  if (!team) {
    return {
      mode: 'collab',
      destination: primary.destination,
      heading: { label: translate('team:pages.personal'), icon: 'person' },
      onPrimary: primary.onPrimary,
      primaryTrailing: primary.primaryTrailing,
      items: [...primary.items, ...folderItems(primary, 'folder', translate('team:shareToTeam.newFolder'))],
    };
  }

  return {
    mode: 'collab',
    destination: team.destination,
    heading: { label: translate('team:pages.sharedWithTeam'), icon: 'groups' },
    onPrimary: team.onPrimary,
    primaryTrailing: team.primaryTrailing,
    items: [
      ...team.items,
      ...folderItems(team, 'folder', translate('team:shareToTeam.newFolder')),
      ...(personal
        ? [
          {
            id: 'personal-page',
            label: translate('team:pages.newPersonalPage'),
            icon: 'person',
            separatorBefore: true,
            trailing: personal.primaryTrailing,
            onSelect: personal.onPrimary,
          },
          ...folderItems(personal, 'personal-folder', translate('team:pages.newPersonalFolder'))
            .map((item) => ({ ...item, separatorBefore: false })),
        ]
        : []),
    ],
  };
}
