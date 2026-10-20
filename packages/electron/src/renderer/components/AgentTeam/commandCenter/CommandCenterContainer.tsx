/**
 * CommandCenterContainer - the only place the Command Center touches state:
 * it reads the same derived rooms the DOM Office reads (useOfficeRooms, which
 * only reads existing atoms) and hands them to the presentational view.
 * Nothing is written, stored or sent.
 */

import React from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import type { TeamTreeNode } from '../agentTeamGraph';
import { useOfficeRooms } from '../office/useOfficeRooms';
import { CommandCenterView } from './CommandCenterView';

export interface CommandCenterContainerProps {
  teams: TeamTreeNode[];
  onSessionOpen: (sessionId: string) => void;
}

export function CommandCenterContainer({ teams, onSessionOpen }: CommandCenterContainerProps) {
  const { t } = useTranslation('agent');
  const rooms = useOfficeRooms(teams, t('sessionItem.untitled'));
  return <CommandCenterView rooms={rooms} onSessionOpen={onSessionOpen} />;
}
