import { describe, expect, it } from 'vitest';

import {
  MAX_TRACKER_ITEM_PAYLOAD_BYTES,
  parseTrackerItemPayload,
  validateTrackerItemPayload,
} from '../teamTracker.js';

/**
 * F1 S1, G-sync conditions 3 and 4: a team-front travels on the existing item
 * lane. The shared validator does not know item types or business fields, so a
 * front is valid when its fixed fields are, with `fields` an object, and it has
 * to stay far below the per-item size cap.
 */
const MAX_DESCRIPTION_CHARS = 2000;

function frontPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemId: 'team-front_01',
    primaryType: 'team-front',
    archived: false,
    bodyVersion: 0,
    fields: {
      title: 'Team Mode',
      status: 'active',
      description: 'Objetivo: ciclo de vida do Team Mode. Autoridade: ESTADO.md.',
      currentMission: 'root-session-1',
    },
    labels: {},
    comments: [],
    activity: [],
    system: {},
    ...overrides,
  };
}

describe('a team-front payload on the tracker item lane', () => {
  it('is valid with its fields as an object, and keeps every field as sent', () => {
    const result = validateTrackerItemPayload(frontPayload(), 'team-front_01');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.value.primaryType).toBe('team-front');
      expect(result.value.fields).toEqual({
        title: 'Team Mode',
        status: 'active',
        description: 'Objetivo: ciclo de vida do Team Mode. Autoridade: ESTADO.md.',
        currentMission: 'root-session-1',
      });
    }
  });

  it('is valid for all three statuses and for a front with no mission', () => {
    for (const status of ['active', 'paused', 'closed']) {
      expect(validateTrackerItemPayload(frontPayload({ fields: { title: 'Portal', status } })).success, status).toBe(true);
    }
  });

  it('tolerates fields it does not know about (an unknown business field is allowed)', () => {
    const result = validateTrackerItemPayload(frontPayload({
      fields: { title: 'Team Mode', status: 'active', someFutureField: { nested: true } },
    }));
    expect(result.success).toBe(true);
  });

  it('still requires fields to be an object, not an array or a scalar', () => {
    for (const fields of [[], ['title'], 'title', null, 7]) {
      const result = validateTrackerItemPayload(frontPayload({ fields }));
      expect(result.success, JSON.stringify(fields)).toBe(false);
      if (!result.success) expect(result.error).toBe('payload.fields must be an object');
    }
  });

  it('stays far under the 256 KiB item cap even at its largest: a 2,000-character state of 4-byte characters, a long title, a mission id', () => {
    const description = '\u{1F680}'.repeat(MAX_DESCRIPTION_CHARS / 2); // 2,000 UTF-16 units, 4 bytes per character
    const json = JSON.stringify(frontPayload({
      fields: {
        title: 'T'.repeat(500),
        status: 'active',
        description,
        currentMission: '00000000-0000-0000-0000-000000000000',
      },
    }));
    const bytes = Buffer.byteLength(json, 'utf8');
    expect(bytes).toBeLessThan(MAX_TRACKER_ITEM_PAYLOAD_BYTES);
    // Not merely under the cap: an order of magnitude of headroom for comments and activity.
    expect(bytes).toBeLessThan(MAX_TRACKER_ITEM_PAYLOAD_BYTES / 10);
    const parsed = parseTrackerItemPayload(json, 'team-front_01');
    expect(parsed.success).toBe(true);
  });

  it('the size cap itself still applies to a front-shaped payload', () => {
    const json = JSON.stringify(frontPayload({ fields: { title: 'x', description: 'd'.repeat(MAX_TRACKER_ITEM_PAYLOAD_BYTES) } }));
    const parsed = parseTrackerItemPayload(json, 'team-front_01');
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error).toContain(`${MAX_TRACKER_ITEM_PAYLOAD_BYTES}`);
  });
});
