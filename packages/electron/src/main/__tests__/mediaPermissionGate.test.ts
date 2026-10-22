import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { getMediaAccessStatus, warn } = vi.hoisted(() => ({
  getMediaAccessStatus: vi.fn<(type: string) => string>(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  systemPreferences: {
    getMediaAccessStatus: (type: string) => getMediaAccessStatus(type),
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { main: { warn, info: vi.fn() } },
}));

import { installMicrophoneGate } from '../mediaPermissionGate';

interface FakePermissionDetails {
  mediaType?: string;
  mediaTypes?: string[];
  requestingUrl?: string;
}

// A fake Electron Session that captures the handlers the gate installs.
function makeFakeSession() {
  let requestHandler:
    | ((wc: unknown, permission: string, cb: (ok: boolean) => void, details: FakePermissionDetails) => void)
    | null = null;
  let checkHandler:
    | ((wc: unknown, permission: string, origin: string, details: FakePermissionDetails) => boolean)
    | null = null;
  return {
    storagePath: null,
    setPermissionRequestHandler: (handler: typeof requestHandler) => { requestHandler = handler; },
    setPermissionCheckHandler: (handler: typeof checkHandler) => { checkHandler = handler; },
    request(permission: string, details: FakePermissionDetails): boolean {
      let result = false;
      requestHandler?.(null, permission, (ok) => { result = ok; }, details);
      return result;
    },
    check(
      permission: string,
      details: FakePermissionDetails,
      origin = 'https://example.com',
    ): boolean {
      return checkHandler ? checkHandler(null, permission, origin, details) : true;
    },
  };
}

const AUDIO = { mediaTypes: ['audio'] };
const VIDEO = { mediaTypes: ['video'] };
const DEFAULT_OPTS = { allowWhenGranted: true, label: 'default' };

describe('installMicrophoneGate', () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: string) =>
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('darwin');
  });

  afterAll(() => setPlatform(realPlatform));

  it('denies audio requests when the mic is not yet granted', () => {
    getMediaAccessStatus.mockReturnValue('not-determined');
    const session = makeFakeSession();
    installMicrophoneGate(session as never, DEFAULT_OPTS);
    expect(session.request('media', AUDIO)).toBe(false);
    expect(session.request('audioCapture', {})).toBe(false);
    expect(session.check('media', AUDIO)).toBe(false);
  });

  it('allows audio once Voice Mode has caused the OS to grant it', () => {
    getMediaAccessStatus.mockReturnValue('granted');
    const session = makeFakeSession();
    installMicrophoneGate(session as never, DEFAULT_OPTS);
    expect(session.request('media', AUDIO)).toBe(true);
    expect(session.check('media', AUDIO)).toBe(true);
  });

  it('never blocks non-audio permissions', () => {
    getMediaAccessStatus.mockReturnValue('denied');
    const session = makeFakeSession();
    installMicrophoneGate(session as never, DEFAULT_OPTS);
    expect(session.request('media', VIDEO)).toBe(true);
    expect(session.request('notifications', {})).toBe(true);
    expect(session.check('media', VIDEO)).toBe(true);
    expect(session.check('clipboard-read', {})).toBe(true);
  });

  it('does not restrict audio on non-macOS platforms', () => {
    setPlatform('win32');
    const session = makeFakeSession();
    installMicrophoneGate(session as never, DEFAULT_OPTS);
    expect(session.request('media', AUDIO)).toBe(true);
    expect(session.check('media', AUDIO)).toBe(true);
    expect(getMediaAccessStatus).not.toHaveBeenCalled();
  });

  it('denies audio in partition sessions even when the OS has granted access', () => {
    getMediaAccessStatus.mockReturnValue('granted');
    const session = makeFakeSession();
    installMicrophoneGate(session as never, {
      allowWhenGranted: false,
      label: 'persist:browser',
    });
    expect(session.request('media', AUDIO)).toBe(false);
    expect(session.check('media', AUDIO)).toBe(false);
    expect(getMediaAccessStatus).not.toHaveBeenCalled();
  });

  it('logs each denied request and check with partition, origin, and permission', () => {
    getMediaAccessStatus.mockReturnValue('denied');
    const session = makeFakeSession();
    installMicrophoneGate(session as never, {
      allowWhenGranted: true,
      label: 'persist:browser',
    });

    expect(session.request('media', {
      mediaTypes: ['audio'],
      requestingUrl: 'https://request.example',
    })).toBe(false);
    expect(session.check('audioCapture', {}, 'https://check.example')).toBe(false);

    expect(warn).toHaveBeenNthCalledWith(
      1,
      '[mediaPermissionGate] denied audio request partition="persist:browser" origin="https://request.example" permission="media"',
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      '[mediaPermissionGate] denied audio check partition="persist:browser" origin="https://check.example" permission="audioCapture"',
    );
  });
});

describe('installMicrophoneGate denyOtherPermissionsFor', () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: string) =>
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });

  beforeEach(() => {
    vi.clearAllMocks();
    setPlatform('darwin');
  });

  afterAll(() => setPlatform(realPlatform));

  it('denies non-audio permissions on request and check', () => {
    const session = makeFakeSession();
    installMicrophoneGate(session as never, { ...DEFAULT_OPTS, denyOtherPermissionsFor: () => true });
    for (const permission of ['geolocation', 'notifications', 'clipboard-read', 'midi']) {
      expect(session.request(permission, {})).toBe(false);
      expect(session.check(permission, {})).toBe(false);
    }
    expect(session.request('media', VIDEO)).toBe(false);
  });

  it('leaves audio handling exactly as before', () => {
    getMediaAccessStatus.mockReturnValue('granted');
    const session = makeFakeSession();
    installMicrophoneGate(session as never, { ...DEFAULT_OPTS, denyOtherPermissionsFor: () => true });
    expect(session.request('media', AUDIO)).toBe(true);
    expect(session.check('audioCapture', {})).toBe(true);
  });

  it('keeps allow-by-default for non-audio permissions when the predicate is absent or false', () => {
    const session = makeFakeSession();
    installMicrophoneGate(session as never, DEFAULT_OPTS);
    expect(session.request('geolocation', {})).toBe(true);
    expect(session.check('notifications', {})).toBe(true);
    installMicrophoneGate(session as never, { ...DEFAULT_OPTS, denyOtherPermissionsFor: () => false });
    expect(session.request('geolocation', {})).toBe(true);
  });
});
