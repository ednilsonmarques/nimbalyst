/**
 * The Office read model, shared by every presentation of the Team view that
 * draws rooms (the DOM Office and the Command Center): one derived read over
 * the atoms the sidebar and the Tree already use, projected by officeModel.
 *
 * Nothing is written, stored or cached beyond React memoisation: the rooms are
 * recalculated from the registry forest and the per-session atoms on change.
 */

import { useMemo } from 'react';
import { atom, useAtomValue } from 'jotai';
import {
  activeSessionIdAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionPendingPromptsAtom,
  sessionProcessingAtom,
} from '../../../store/atoms/sessions';
import { sessionErrorAtom } from '../../../store/atoms/sessionTranscript';
import type { TeamTreeNode } from '../agentTeamGraph';
import { buildOfficeRoom, officeRoomSessions, type OfficeMemberSignals, type OfficeRoomView } from './officeModel';

export function useOfficeRooms(teams: TeamTreeNode[], untitled: string): OfficeRoomView[] {
  const sessionIds = useMemo(
    () => teams.flatMap((root) => officeRoomSessions(root).map((session) => session.id)),
    [teams],
  );
  const idsKey = sessionIds.join('\n');
  // One derived read over the existing atoms; nothing is written or cached.
  const signalsAtom = useMemo(
    () =>
      atom((get) => {
        const signals = new Map<string, OfficeMemberSignals>();
        for (const id of sessionIds) {
          signals.set(id, {
            processing: get(sessionProcessingAtom(id)),
            awaitingUser: get(sessionHasPendingInteractivePromptAtom(id)),
            pendingPromptTypes: get(sessionPendingPromptsAtom(id)).map((prompt) => prompt.promptType),
            errorReported: get(sessionErrorAtom(id)) !== null,
          });
        }
        return signals;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [idsKey],
  );
  const signalsById = useAtomValue(signalsAtom);
  const activeSessionId = useAtomValue(activeSessionIdAtom);
  return useMemo(
    () => teams.map((root) => buildOfficeRoom(root, signalsById, activeSessionId, untitled)),
    [teams, signalsById, activeSessionId, untitled],
  );
}
