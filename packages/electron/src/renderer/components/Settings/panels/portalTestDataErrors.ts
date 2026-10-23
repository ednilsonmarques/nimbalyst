/**
 * Maps the error CODE `portal:set-test-data` answers with to an i18n key. Main
 * never sends UI text for this setting; an unknown or missing code falls back to
 * the generic message.
 */

export const PORTAL_TEST_DATA_GENERIC_ERROR_KEY = 'projectPermissions.errors.portalTestData';

export const PORTAL_TEST_DATA_ERROR_KEYS = {
  notProjectWindow: 'projectPermissions.errors.portalTestDataNotProjectWindow',
  noUserInput: 'projectPermissions.errors.portalTestDataNoUserInput',
} as const;

export function portalTestDataErrorKey(code: unknown): string {
  if (typeof code === 'string' && Object.prototype.hasOwnProperty.call(PORTAL_TEST_DATA_ERROR_KEYS, code)) {
    return PORTAL_TEST_DATA_ERROR_KEYS[code as keyof typeof PORTAL_TEST_DATA_ERROR_KEYS];
  }
  return PORTAL_TEST_DATA_GENERIC_ERROR_KEY;
}

/** A user-cancelled native confirmation is not an error: the setting just stays as it was. */
export function shouldShowPortalTestDataError(code: unknown): boolean {
  return code !== 'notConfirmed';
}

/** A port typed in the settings card: a whole number from 1 to 65535, or null. */
export function parsePortInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}
