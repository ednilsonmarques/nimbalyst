// @vitest-environment node
/** Collab product status text is translated for display only; the derived status stays English. */
import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage } from '@nimbalyst/runtime/i18n';
import type { DocumentSyncStatus, LocalDocumentReplicaOutboxState, LocalDocumentReplicaState } from '@nimbalyst/runtime/sync';

import { deriveCollabProductStatus, localizeCollabProductStatus } from '../collabEditor';

const replicas: Array<LocalDocumentReplicaState | undefined> = ['loading', 'ready', 'corrupt', 'unavailable', undefined];
const transports: DocumentSyncStatus[] = ['disconnected', 'connecting', 'syncing', 'connected', 'replaying', 'error', 'offline-unsynced'];
const outboxes: LocalDocumentReplicaOutboxState[] = ['clean', 'pending', 'replaying', 'rejected'];

const statuses = replicas.flatMap((replica) =>
  transports.flatMap((transport) =>
    outboxes.flatMap((outbox) => [false, true].map((renderFailed) =>
      deriveCollabProductStatus({ replica, transport, outbox, renderFailed }),
    )),
  ),
);

afterEach(async () => {
  await setLanguage('en');
});

describe('localizeCollabProductStatus', () => {
  it('is the identity in English', async () => {
    await setLanguage('en');
    for (const status of statuses) {
      expect(localizeCollabProductStatus(status)).toEqual(status);
    }
  });

  it('translates every label and detail in pt-BR without touching the logic fields', async () => {
    await setLanguage('pt-BR');
    for (const status of statuses) {
      const localized = localizeCollabProductStatus(status);
      expect(localized.kind).toBe(status.kind);
      expect(localized.severity).toBe(status.severity);
      expect(localized.label).not.toMatch(/^team:|collabStatus\./);
      if (status.label !== 'Offline') expect(localized.label).not.toBe(status.label);
      if (status.detail) expect(localized.detail).not.toBe(status.detail);
      else expect(localized.detail).toBeNull();
    }
    const synced = statuses.find((status) => status.kind === 'synced')!;
    expect(localizeCollabProductStatus(synced).label).toBe('Sincronizado');
    // The atom value itself never changes language.
    expect(synced.label).toBe('Synced');
  });

  it('passes unknown text through unchanged', async () => {
    await setLanguage('pt-BR');
    const synced = statuses.find((status) => status.kind === 'synced')!;
    expect(localizeCollabProductStatus({ ...synced, label: 'Custom', detail: 'Raw detail' }))
      .toMatchObject({ label: 'Custom', detail: 'Raw detail' });
  });
});
