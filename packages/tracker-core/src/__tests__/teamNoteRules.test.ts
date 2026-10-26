// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  TEAM_NOTE_BODY_MAX_CHARS,
  TEAM_NOTE_HANDOFF_BODY_MAX_CHARS,
  TEAM_NOTE_HANDOFF_ONLY_FIELDS,
  TEAM_NOTE_HANDOFF_RESULTS,
  TEAM_NOTE_KINDS,
  TEAM_NOTE_NEXT_ACTION_KINDS,
  TEAM_NOTE_PROVENANCE_FIELDS,
  assertProtectedTrackerBody,
  assertProtectedTrackerUpdate,
  assertTeamNoteBody,
  assertTeamNoteUpdate,
  prepareManualTeamNoteCreate,
  prepareProtectedTrackerCreate,
  prepareTeamNoteCreate,
  teamNoteBodyError,
  teamNoteBodyLimit,
  validateTeamNoteData,
} from "../index";

// F1 S2: team-note gets `front` (host-owned), `nextAction`, the `handoff` kind and its structured fields.

const lexical = (text: string) => ({
  root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text }] }] },
});

/** A note as the app's agent tool stores it (provenance filled by the host). */
const decision = {
  title: "Port the rules gradually",
  status: "active",
  noteKind: "decision",
  description: "Decided with the user.",
  sourceSession: "root-1",
  teamRootSession: "root-1",
  agentRole: "coordinator",
  front: "team-front_1",
};
const pending = { ...decision, noteKind: "pending", nextAction: "Ask PCP which formula is official." };
const handoff = {
  ...decision,
  noteKind: "handoff",
  nextAction: "Run C0 on the 26-0146 entries.",
  result: "partial",
  commits: ["abc1234 add rules"],
  pendings: [{ itemId: "nte_1" }],
  relatedNotes: ["nte_2"],
};

describe("the closed lists, with exact equality", () => {
  it("note kinds: the six existing ones, then handoff", () => {
    expect([...TEAM_NOTE_KINDS]).toEqual(["decision", "discovery", "risk", "pending", "test", "context", "handoff"]);
  });

  it("provenance fields: the five existing ones, then front", () => {
    expect([...TEAM_NOTE_PROVENANCE_FIELDS]).toEqual(["sourceSession", "teamRootSession", "agentRole", "branch", "worktree", "front"]);
  });

  it("the cap is 600 for every kind and 2,500 for a handoff", () => {
    expect(TEAM_NOTE_BODY_MAX_CHARS).toBe(600);
    expect(TEAM_NOTE_HANDOFF_BODY_MAX_CHARS).toBe(2500);
    for (const kind of TEAM_NOTE_KINDS) expect(teamNoteBodyLimit(kind), kind).toBe(kind === "handoff" ? 2500 : 600);
    expect(teamNoteBodyLimit(undefined)).toBe(600);
    expect(teamNoteBodyLimit("not-a-kind")).toBe(600);
  });

  it("the kinds that need a next action, the handoff results and the handoff-only fields", () => {
    expect([...TEAM_NOTE_NEXT_ACTION_KINDS]).toEqual(["pending", "handoff"]);
    expect([...TEAM_NOTE_HANDOFF_RESULTS]).toEqual(["completed", "partial", "abandoned"]);
    expect([...TEAM_NOTE_HANDOFF_ONLY_FIELDS]).toEqual(["result", "commits", "pendings", "relatedNotes"]);
  });
});

describe("nextAction on create", () => {
  const manual = (data: Record<string, unknown>, body?: unknown) => () => prepareManualTeamNoteCreate("team-note", { title: "t", ...data }, body);

  it("a pending note needs one; whitespace is not one", () => {
    expect(manual({ noteKind: "pending" })).toThrow(/nextAction/);
    expect(manual({ noteKind: "pending", nextAction: "" })).toThrow(/nextAction/);
    expect(manual({ noteKind: "pending", nextAction: "   \n " })).toThrow(/nextAction/);
    expect(manual({ noteKind: "pending", nextAction: 42 })).toThrow(/nextAction/);
    expect(manual({ noteKind: "pending", nextAction: "Ask PCP." })).not.toThrow();
  });

  it("a handoff needs one too, and a result", () => {
    expect(manual({ noteKind: "handoff", result: "completed" })).toThrow(/nextAction/);
    expect(manual({ noteKind: "handoff", nextAction: "Next." })).toThrow(/result/);
    expect(manual({ noteKind: "handoff", nextAction: "Next.", result: "completed" })).not.toThrow();
  });

  it("the other kinds do not", () => {
    for (const noteKind of ["decision", "discovery", "risk", "test", "context"]) {
      expect(manual({ noteKind }), noteKind).not.toThrow();
    }
  });

  it("the agent path judges it the same way", () => {
    expect(() => prepareProtectedTrackerCreate("team-note", { ...pending, nextAction: undefined }, { provenanceFromHost: true })).toThrow(/nextAction/);
    expect(() => prepareProtectedTrackerCreate("team-note", { ...pending }, { provenanceFromHost: true })).not.toThrow();
  });

  it("a nextAction found in the synced customFields bag counts", () => {
    expect(manual({ noteKind: "pending", customFields: { nextAction: "Ask PCP." } })).not.toThrow();
  });
});

describe("handoff on create", () => {
  const create = (data: Record<string, unknown>, body?: unknown) =>
    () => prepareTeamNoteCreate("team-note", { ...data }, body, { allowProvenance: true });

  it("a complete handoff is accepted, with its structured fields", () => {
    expect(create(handoff)).not.toThrow();
    for (const result of TEAM_NOTE_HANDOFF_RESULTS) expect(create({ ...handoff, result }), result).not.toThrow();
  });

  it("result must be one of completed, partial, abandoned", () => {
    expect(create({ ...handoff, result: "done" })).toThrow(/result must be one of: completed, partial, abandoned/);
    expect(create({ ...handoff, result: "" })).toThrow(/result/);
    expect(create({ ...handoff, result: undefined })).toThrow(/result/);
  });

  it("commits is a list of strings", () => {
    expect(create({ ...handoff, commits: "abc1234" })).toThrow(/commits must be a list of strings/);
    expect(create({ ...handoff, commits: [1, 2] })).toThrow(/commits must be a list of strings/);
    expect(create({ ...handoff, commits: [] })).not.toThrow();
  });

  it("result, commits, pendings and relatedNotes are refused on every other kind", () => {
    for (const noteKind of ["decision", "discovery", "risk", "pending", "test", "context"]) {
      const base = { ...decision, noteKind, nextAction: "Next." };
      for (const [field, value] of [["result", "completed"], ["commits", ["abc1234"]], ["pendings", ["nte_1"]], ["relatedNotes", [{ itemId: "nte_2" }]]] as const) {
        expect(create({ ...base, [field]: value }), `${noteKind}.${field}`).toThrow(new RegExp(`${field}.* only for .*handoff`));
      }
      // Empty values are not a use of the field.
      expect(create({ ...base, result: "", commits: [], pendings: [], relatedNotes: null }), noteKind).not.toThrow();
    }
  });
});

describe("the body cap, by kind", () => {
  const create = (noteKind: string, body: unknown, extra: Record<string, unknown> = {}) =>
    () => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind, nextAction: "Next.", result: noteKind === "handoff" ? "completed" : undefined, ...extra }, body);

  it("a handoff may carry 2,500 characters, as text or as a rich body, and not one more", () => {
    expect(create("handoff", "x".repeat(2500))).not.toThrow();
    expect(create("handoff", lexical("x".repeat(2500)))).not.toThrow();
    expect(create("handoff", "x".repeat(2501))).toThrow(/limit is 2500/);
    expect(create("handoff", lexical("x".repeat(2501)))).toThrow(/limit is 2500/);
    expect(create("handoff", null, { description: "d".repeat(2500) })).not.toThrow();
    expect(create("handoff", null, { description: "d".repeat(2501) })).toThrow(/limit is 2500/);
  });

  it("every other kind keeps 600", () => {
    for (const noteKind of ["decision", "discovery", "risk", "pending", "test", "context"]) {
      expect(create(noteKind, "x".repeat(600)), noteKind).not.toThrow();
      expect(create(noteKind, "x".repeat(601)), noteKind).toThrow(/limit is 600/);
      expect(create(noteKind, null, { description: "d".repeat(601) }), noteKind).toThrow(/limit is 600/);
    }
  });

  it("teamNoteBodyError and the body assertions take the kind", () => {
    expect(teamNoteBodyError("x".repeat(2000), "handoff")).toBeNull();
    expect(teamNoteBodyError("x".repeat(2000), "decision")).toMatch(/limit is 600/);
    expect(teamNoteBodyError("x".repeat(2000))).toMatch(/limit is 600/);
    expect(() => assertTeamNoteBody("team-note", "x".repeat(2000), { noteKind: "handoff" })).not.toThrow();
    expect(() => assertTeamNoteBody("team-note", "x".repeat(2000), { noteKind: "decision" })).toThrow(/limit is 600/);
    expect(() => assertTeamNoteBody("team-note", "x".repeat(2000))).toThrow(/limit is 600/);
    expect(() => assertProtectedTrackerBody("team-note", "x".repeat(2000), { noteKind: "handoff" })).not.toThrow();
    expect(() => assertProtectedTrackerBody("team-note", "x".repeat(2000), { noteKind: "risk" })).toThrow(/limit is 600/);
  });
});

describe("front is host-owned, like the other provenance fields", () => {
  it("a manual create cannot set it; the agent path (host-filled) can", () => {
    expect(() => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind: "risk", front: "team-front_1" })).toThrow(/front is set by Nimbalyst from the agent session/);
    expect(() => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind: "risk", front: { itemId: "team-front_1" } })).toThrow(/front is set by Nimbalyst/);
    expect(() => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind: "risk", customFields: { front: "team-front_1" } })).toThrow(/front is set by Nimbalyst/);
    expect(() => prepareProtectedTrackerCreate("team-note", { ...decision }, { provenanceFromHost: true })).not.toThrow();
    // A note with no front (a standalone session, a mission without one) is fine, and so is an emptied value.
    expect(() => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind: "risk" })).not.toThrow();
    expect(() => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind: "risk", front: null })).not.toThrow();
    expect(() => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind: "risk", front: [] })).not.toThrow();
  });

  it("no update changes, sets or clears it", () => {
    const set = (changes: Record<string, unknown>) => () => assertTeamNoteUpdate("team-note", changes, decision, { ...decision, ...changes });
    expect(set({ front: "team-front_2" })).toThrow(/front records where the note came from and cannot be changed/);
    expect(set({ front: { itemId: "team-front_2" } })).toThrow(/front records where the note came from/);
    expect(set({ front: null })).toThrow(/front records where the note came from/);
    expect(set({ front: [] })).toThrow(/front records where the note came from/);
    expect(() => assertTeamNoteUpdate("team-note", { unsetFields: ["front"] }, decision, { ...decision, front: undefined })).toThrow(/front records/);
    // A note that had none cannot be given one.
    const { front: _front, ...noFront } = decision;
    expect(() => assertTeamNoteUpdate("team-note", { front: "team-front_1" }, noFront, { ...noFront, front: "team-front_1" })).toThrow(/front records/);
  });

  it("the same front in another storage shape is no change: the funnels canonicalize and nest relationship values", () => {
    const stored = { ...decision, front: "team-front_1" };
    const same = (after: Record<string, unknown>) => () => assertTeamNoteUpdate("team-note", { status: "resolved" }, stored, { ...after, status: "resolved" });
    expect(same({ ...decision, front: { itemId: "team-front_1" } })).not.toThrow();
    expect(same({ ...decision, front: { itemId: "team-front_1", trackerType: "team-front", direction: "out" } })).not.toThrow();
    expect(same({ ...decision, front: ["team-front_1"] })).not.toThrow();
    const { front: _f, ...rest } = decision;
    expect(same({ ...rest, customFields: { front: { itemId: "team-front_1" } } })).not.toThrow();
    // And back: stored as an object, written as the id.
    expect(() => assertTeamNoteUpdate("team-note", { status: "resolved" }, { ...decision, front: { itemId: "team-front_1" } }, { ...decision, status: "resolved" })).not.toThrow();
    // A top-level write naming another front in the other shape is still a change.
    expect(same({ ...rest, customFields: { front: { itemId: "team-front_1" } }, front: "team-front_9" })).toThrow(/front records/);
  });
});

describe("nextAction on update", () => {
  /** Existing pending notes, from before S2: no nextAction. */
  const legacyPending = { ...decision, noteKind: "pending" };

  it("a legacy pending note without nextAction still takes unrelated updates", () => {
    const legacy = (changes: Record<string, unknown>) => () => assertTeamNoteUpdate("team-note", changes, legacyPending, { ...legacyPending, ...changes });
    expect(legacy({ status: "resolved" })).not.toThrow();
    expect(legacy({ status: "obsolete" })).not.toThrow();
    expect(legacy({ title: "Renamed" })).not.toThrow();
    expect(legacy({ description: "A shorter text." })).not.toThrow();
    expect(legacy({ files: ["a.ts"] })).not.toThrow();
    expect(legacy({ customFields: { supersedes: ["nte_1"] } })).not.toThrow();
    // Even writing the empty value it already has is no change.
    expect(legacy({ nextAction: "" })).not.toThrow();
  });

  it("an update that clears it on a pending or handoff note is refused", () => {
    expect(() => assertTeamNoteUpdate("team-note", { nextAction: "" }, pending, { ...pending, nextAction: "" })).toThrow(/nextAction/);
    expect(() => assertTeamNoteUpdate("team-note", { nextAction: "  " }, pending, { ...pending, nextAction: "  " })).toThrow(/nextAction/);
    expect(() => assertTeamNoteUpdate("team-note", { unsetFields: ["nextAction"] }, pending, { ...pending, nextAction: undefined })).toThrow(/nextAction/);
    expect(() => assertTeamNoteUpdate("team-note", { nextAction: "" }, handoff, { ...handoff, nextAction: "" })).toThrow(/nextAction/);
    expect(() => assertTeamNoteUpdate("team-note", { nextAction: "New step." }, pending, { ...pending, nextAction: "New step." })).not.toThrow();
  });

  it("an update that changes the kind to pending or handoff needs it", () => {
    expect(() => assertTeamNoteUpdate("team-note", { noteKind: "pending" }, decision, { ...decision, noteKind: "pending" })).toThrow(/nextAction/);
    expect(() => assertTeamNoteUpdate("team-note", { noteKind: "pending", nextAction: "Next." }, decision, { ...decision, noteKind: "pending", nextAction: "Next." })).not.toThrow();
    expect(() => assertTeamNoteUpdate("team-note", { noteKind: "handoff", nextAction: "Next." }, decision, { ...decision, noteKind: "handoff", nextAction: "Next." })).toThrow(/result/);
    expect(() => assertTeamNoteUpdate("team-note", { noteKind: "handoff" }, decision, { ...decision, noteKind: "handoff", result: "completed" })).toThrow(/nextAction/);
    expect(() => assertTeamNoteUpdate("team-note", { noteKind: "handoff" }, decision, { ...decision, noteKind: "handoff", nextAction: "Next.", result: "completed" })).not.toThrow();
    // A legacy pending note moving to handoff is a kind change like any other.
    expect(() => assertTeamNoteUpdate("team-note", { noteKind: "handoff" }, legacyPending, { ...legacyPending, noteKind: "handoff", result: "completed" })).toThrow(/nextAction/);
  });

  it("changing from pending to another kind does not need it", () => {
    expect(() => assertTeamNoteUpdate("team-note", { noteKind: "decision" }, pending, { ...pending, noteKind: "decision", nextAction: undefined })).not.toThrow();
  });
});

describe("handoff on update", () => {
  it("clearing the result is refused; changing it to another valid one is not an issue of the rule", () => {
    expect(() => assertTeamNoteUpdate("team-note", { result: "" }, handoff, { ...handoff, result: "" })).toThrow(/result/);
    expect(() => assertTeamNoteUpdate("team-note", { result: "bogus" }, handoff, { ...handoff, result: "bogus" })).toThrow(/result must be one of/);
    expect(() => assertTeamNoteUpdate("team-note", { result: "completed" }, handoff, { ...handoff, result: "completed" })).not.toThrow();
  });

  it("leaving handoff while its structured fields remain is refused; clearing them first is fine", () => {
    expect(() => assertTeamNoteUpdate("team-note", { noteKind: "decision" }, handoff, { ...handoff, noteKind: "decision" })).toThrow(/only for .*handoff/);
    const cleared = { ...handoff, noteKind: "decision", result: undefined, commits: [], pendings: [], relatedNotes: null };
    expect(() => assertTeamNoteUpdate("team-note", { noteKind: "decision" }, handoff, cleared)).not.toThrow();
  });

  it("the cap follows the resulting kind: 2,500 as a handoff, 600 once it is something else", () => {
    const long = "x".repeat(2000);
    expect(() => assertTeamNoteUpdate("team-note", { description: long }, handoff, { ...handoff, description: long })).not.toThrow();
    expect(() => assertTeamNoteUpdate("team-note", { description: "x".repeat(2501) }, handoff, { ...handoff, description: "x".repeat(2501) })).toThrow(/limit is 2500/);
    expect(() => assertTeamNoteUpdate("team-note", { description: long }, decision, { ...decision, description: long })).toThrow(/limit is 600/);
  });

  it("goes through the single protected entry point", () => {
    expect(() => assertProtectedTrackerUpdate("team-note", { description: "x".repeat(2000) }, handoff, { ...handoff, description: "x".repeat(2000) })).not.toThrow();
    expect(() => assertProtectedTrackerUpdate("team-note", { nextAction: "" }, pending, { ...pending, nextAction: "" }, { agent: true })).toThrow(/nextAction/);
  });
});

describe("validateTeamNoteData", () => {
  it("reports every problem of a handoff at once", () => {
    const problems = validateTeamNoteData({ title: "t", noteKind: "handoff", status: "active" }, { mode: "create" });
    expect(problems.some((p) => /nextAction/.test(p))).toBe(true);
    expect(problems.some((p) => /result/.test(p))).toBe(true);
  });
});

describe("review follow-up (F1 S2b)", () => {
  describe("the stored rich body is judged against the cap of the resulting kind", () => {
    const longBody = JSON.stringify("x".repeat(2400)); // as the content column stores a markdown body
    const leaving = (extra: Record<string, unknown> = {}) => ({ ...handoff, noteKind: "decision", result: "", commits: [], pendings: [], relatedNotes: [], ...extra });

    it("a note that leaves handoff with a stored body over 600 is refused, with the 600 limit", () => {
      const after = leaving();
      expect(() => assertTeamNoteUpdate("team-note", { noteKind: "decision" }, handoff, after, { storedBody: longBody })).toThrow(/limit is 600/);
      expect(() => assertProtectedTrackerUpdate("team-note", { noteKind: "decision" }, handoff, after, { storedBody: longBody })).toThrow(/limit is 600/);
      // Raw text and a rich document count the same.
      expect(() => assertTeamNoteUpdate("team-note", { noteKind: "decision" }, handoff, after, { storedBody: "x".repeat(2400) })).toThrow(/limit is 600/);
      expect(() => assertTeamNoteUpdate("team-note", { noteKind: "decision" }, handoff, after, { storedBody: lexical("x".repeat(2400)) })).toThrow(/limit is 600/);
    });

    it("the same change with a short body, an empty body or an unseen body passes", () => {
      const after = leaving();
      expect(() => assertTeamNoteUpdate("team-note", { noteKind: "decision" }, handoff, after, { storedBody: JSON.stringify("short") })).not.toThrow();
      expect(() => assertTeamNoteUpdate("team-note", { noteKind: "decision" }, handoff, after, { storedBody: null })).not.toThrow();
      expect(() => assertTeamNoteUpdate("team-note", { noteKind: "decision" }, handoff, after)).not.toThrow();
    });

    it("a note that stays a handoff keeps its 2,500; going to handoff is never a reason to refuse a long body", () => {
      expect(() => assertTeamNoteUpdate("team-note", { status: "resolved" }, handoff, { ...handoff, status: "resolved" }, { storedBody: longBody })).not.toThrow();
      expect(() => assertTeamNoteUpdate("team-note", { noteKind: "handoff" }, decision, { ...handoff }, { storedBody: longBody })).not.toThrow();
    });

    it("an unrelated edit of a note whose stored body was already over the cap is not held up by it (the kind did not change)", () => {
      expect(() => assertTeamNoteUpdate("team-note", { status: "resolved" }, decision, { ...decision, status: "resolved" }, { storedBody: longBody })).not.toThrow();
    });
  });

  describe("the next action refusal says where an agent puts it", () => {
    it("names fields.nextAction, on create and on update", () => {
      expect(() => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind: "pending" })).toThrow(/needs nextAction.*\(set it as fields\.nextAction\)/);
      expect(() => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind: "handoff", result: "completed" })).toThrow(/A handoff Team Note needs nextAction.*fields\.nextAction/);
      expect(() => assertTeamNoteUpdate("team-note", { nextAction: "" }, pending, { ...pending, nextAction: "" })).toThrow(/fields\.nextAction/);
    });
  });

  describe("a value that is not shaped like a relationship is refused, never read as empty", () => {
    const garbage: Array<[string, unknown]> = [["a number", 42], ["a boolean", true], ["an empty object", {}], ["an object with no id", { title: "x" }], ["a list of numbers", [42]], ["a list with an empty object", [{}]]];

    it("front, on create and on update, whatever was stored before", () => {
      const { front: _front, ...noFront } = decision;
      for (const [label, value] of garbage) {
        expect(() => prepareManualTeamNoteCreate("team-note", { title: "t", noteKind: "risk", front: value }), label).toThrow(/front must be empty or a relationship/);
        expect(() => prepareProtectedTrackerCreate("team-note", { ...decision, front: value }, { provenanceFromHost: true }), label).toThrow(/front must be empty or a relationship/);
        expect(() => assertTeamNoteUpdate("team-note", { front: value }, noFront, { ...noFront, front: value }), label).toThrow(/front must be empty or a relationship/);
        expect(() => assertTeamNoteUpdate("team-note", { front: value }, decision, { ...decision, front: value }), label).toThrow(/front/);
        // And in the nested storage shape, or shadowed at the top level.
        expect(() => assertTeamNoteUpdate("team-note", {}, noFront, { ...noFront, customFields: { front: value } }), label).toThrow(/front must be empty or a relationship/);
      }
    });

    it("pendings and relatedNotes of a handoff, and on any other kind", () => {
      for (const [label, value] of garbage) {
        for (const field of ["pendings", "relatedNotes"]) {
          expect(() => prepareTeamNoteCreate("team-note", { ...handoff, [field]: value }, undefined, { allowProvenance: true }), `${field} ${label}`).toThrow(new RegExp(`${field} must be empty or a relationship`));
          expect(() => prepareTeamNoteCreate("team-note", { ...decision, [field]: value }, undefined, { allowProvenance: true }), `${field} ${label} on a decision`).toThrow(new RegExp(field));
        }
      }
    });

    it("every well-formed value still passes: an id, an object, a list of them, null, an empty string, an empty list", () => {
      const { front: _front, ...noFront } = decision;
      for (const value of ["team-front_1", { itemId: "team-front_1" }, { id: "team-front_1" }, ["team-front_1"], [{ itemId: "team-front_1" }], null, "", []]) {
        expect(() => prepareProtectedTrackerCreate("team-note", { ...noFront, front: value }, { provenanceFromHost: true }), JSON.stringify(value)).not.toThrow();
      }
      for (const value of ["nte_1", { itemId: "nte_1" }, ["nte_1", "nte_2"], [{ itemId: "nte_1" }], null, "", []]) {
        expect(() => prepareTeamNoteCreate("team-note", { ...handoff, pendings: value, relatedNotes: value }, undefined, { allowProvenance: true }), JSON.stringify(value)).not.toThrow();
      }
    });
  });
});
