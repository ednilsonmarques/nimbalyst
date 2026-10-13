/**
 * The `team-note` rules live in `@nimbalyst/tracker-core`
 * (protectedTypes/teamNoteRules.ts) so the app and the offline CLI carry one
 * rule; this module keeps the runtime's import path.
 */
export {
  TEAM_NOTE_TYPE,
  TEAM_NOTE_BODY_MAX_CHARS,
  TEAM_NOTE_KINDS,
  TEAM_NOTE_STATUSES,
  TEAM_NOTE_PROVENANCE_FIELDS,
  readTeamNoteField,
  teamNoteBodyLength,
  teamNoteBodyError,
  teamNoteKindError,
  teamNoteStatusError,
  validateTeamNoteData,
  teamNoteTypeChangeError,
  prepareTeamNoteCreate,
  prepareManualTeamNoteCreate,
  assertTeamNoteUpdate,
  assertTeamNoteBody,
} from '@nimbalyst/tracker-core';
export type { TeamNoteCreateOptions, TeamNoteValidationOptions } from '@nimbalyst/tracker-core';
