export interface FileSaveResult {
  success: boolean;
  conflict?: boolean;
  deleted?: boolean;
  errorType?: string;
  errorCode?: string;
}

import { t } from '@nimbalyst/runtime/i18n';

export class FileSaveRejectedError extends Error {
  readonly errorType: string;
  readonly code: string;

  constructor(errorType: string, errorCode: string) {
    super(`File save failed (${errorType})`);
    this.name = 'FileSaveRejectedError';
    this.errorType = errorType;
    this.code = errorCode;
  }
}

/**
 * User-facing explanation for a failed write. Every branch ends with the same
 * reassurance that nothing was lost -- the buffer is always preserved.
 */
export function getSaveFailureMessage(
  errorType: string,
  source: 'auto' | 'manual',
): string {
  const scope = source === 'auto' ? 'auto' : 'manual';
  switch (errorType) {
    case 'permission':
      return t(`errors:save.${scope}.permission`);
    case 'disk_full':
      return t(`errors:save.${scope}.diskFull`);
    case 'not_found':
      return t(`errors:save.${scope}.notFound`);
    case 'is_directory':
    case 'invalid_path':
      return t(`errors:save.${scope}.notWritable`);
    case 'resource_limit':
    case 'io':
      return t(`errors:save.${scope}.osWrite`);
    case 'conflict':
      return t(`errors:save.${scope}.conflict`);
    case 'empty_write_blocked':
      return t(`errors:save.${scope}.emptyWrite`);
    default:
      return t(`errors:save.${scope}.generic`);
  }
}

/**
 * Reduce a failed save result to the single error type the UI reports.
 * `deleted` and `conflict` are distinct flags rather than error types, so they
 * are folded in here to keep every caller's message selection consistent.
 */
export function resolveSaveFailureType(result: FileSaveResult | null): string {
  if (result?.deleted) return 'not_found';
  if (result?.conflict) return 'conflict';
  return result?.errorType ?? 'unknown';
}

/**
 * IPC-level write failures resolve to a structured result so the renderer can
 * preserve its dirty buffer. Automatic callers must turn that result back into
 * a rejection; otherwise they would clear dirty state after a failed write.
 */
export function assertFileSaveSucceeded(result: FileSaveResult | null): void {
  if (result?.success) return;
  throw new FileSaveRejectedError(
    resolveSaveFailureType(result),
    result?.errorCode ?? 'UNKNOWN',
  );
}
