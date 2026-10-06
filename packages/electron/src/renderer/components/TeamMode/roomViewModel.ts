import type { CollaborationAction } from '@nimbalyst/collab-protocol';

import type { ConversationDirectoryEntry } from '../../../shared/conversationDirectory';
import type {
  CommentCapabilities,
  MentionDirectory,
} from '../Comments/commentTypes';
import { dmLabel, roomLabel } from './orgSidebarViewModel';
import { t as translate } from '@nimbalyst/runtime/i18n';
import type { OrgRosterMember } from './useOrgRoster';

/**
 * Project the server's action list onto the comment stack's capability shape.
 *
 * The server is authoritative: a capability the descriptor does not carry is
 * never granted here, so a room the viewer may only read renders a read-only
 * composer instead of a control whose append the server would reject.
 */
export function toCommentCapabilities(
  actions: readonly CollaborationAction[],
): CommentCapabilities {
  const granted = new Set(actions);
  return {
    read: granted.has('read'),
    comment: granted.has('comment'),
    react: granted.has('react'),
    editOwn: granted.has('editOwnComment'),
    deleteOwn: granted.has('deleteOwnComment'),
    moderate: granted.has('moderateComments'),
    manageRoom: granted.has('manageRoom'),
  };
}

export interface RoomHeaderModel {
  /** Rendered after the `#` for rooms; DMs have no prefix. */
  title: string;
  prefix: '#' | '';
  topic?: string;
  isPrivate: boolean;
  isDirectMessage: boolean;
  archived: boolean;
  /** The composer placeholder, e.g. "Message #general". */
  composerLabel: string;
}

export function buildRoomHeader(
  entry: ConversationDirectoryEntry,
  options: {
    dmParticipants?: readonly string[];
    memberNames?: Readonly<Record<string, string>>;
    viewerUserId?: string;
  } = {},
): RoomHeaderModel {
  const isDm = entry.kind === 'dm';
  const title = isDm
    ? dmLabel(
      options.dmParticipants ?? [],
      options.memberNames,
      options.viewerUserId,
    )
    : roomLabel(entry);
  const prefix = isDm ? '' : '#';
  return {
    title,
    prefix,
    topic: entry.topic?.trim() || undefined,
    isPrivate: isDm || entry.visibility === 'private',
    isDirectMessage: isDm,
    archived: entry.archivedAt !== undefined,
    composerLabel: translate('team:comments.composer.messageAria', { surface: `${prefix}${title}` }),
  };
}

/**
 * What an empty room says.
 *
 * "No messages yet" states a fact nobody needed; the first person into a room
 * needs to know they are at the beginning of it and that writing is the next
 * move. An archived room says so instead — there is no next move there.
 */
export function roomEmptyLabel(
  header: RoomHeaderModel,
  canComment: boolean,
): string {
  const name = `${header.prefix}${header.title}`;
  if (header.archived) {
    return translate('team:room.empty.archived', { name });
  }
  if (header.isDirectMessage) {
    return canComment
      ? translate('team:room.empty.dmCanComment', { name: header.title })
      : translate('team:room.empty.dm', { name: header.title });
  }
  return canComment
    ? translate('team:room.empty.roomCanComment', { name })
    : translate('team:room.empty.room', { name });
}

/**
 * The organization roster as a mention directory.
 *
 * Handles come from the email local part rather than the display name: names
 * repeat and contain spaces, and the `@` picker needs something typeable and
 * unique. Collisions get a numeric suffix so two `@sam`s stay addressable.
 */
export function toMentionDirectory(
  members: readonly OrgRosterMember[],
  viewerUserId?: string,
): MentionDirectory {
  const used = new Set<string>();
  const people = members.map((member) => {
    const base = mentionHandleBase(member);
    let handle = base;
    let suffix = 2;
    while (used.has(handle)) handle = `${base}${suffix++}`;
    used.add(handle);
    const displayName = member.name?.trim() || member.email || member.memberId;
    return {
      userId: member.memberId,
      displayName: member.memberId === viewerUserId ? 'You' : displayName,
      handle,
      avatarInitials: initialsFor(displayName),
      ...(member.role ? { subtitle: member.role } : {}),
    };
  });
  return {
    people,
    agents: [],
    displayNames: Object.fromEntries(
      people.map((person) => [person.userId, person.displayName]),
    ),
  };
}

function mentionHandleBase(member: OrgRosterMember): string {
  const local = member.email?.split('@')[0] ?? '';
  const slug = (local || member.name || member.memberId)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '');
  return slug || 'member';
}

function initialsFor(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export type RoomNotificationLevel = 'all' | 'mentions' | 'none';

export const ROOM_NOTIFICATION_LEVELS: Array<{
  id: RoomNotificationLevel;
  label: string;
  description: string;
  icon: string;
}> = [
  {
    id: 'all',
    label: 'All messages',
    description: 'Every message in this conversation reaches your inbox.',
    icon: 'notifications_active',
  },
  {
    id: 'mentions',
    label: 'Mentions only',
    description: 'Only messages that mention you reach your inbox.',
    icon: 'alternate_email',
  },
  {
    id: 'none',
    label: 'Nothing',
    description: 'Nothing from this conversation reaches your inbox.',
    icon: 'notifications_off',
  },
];
