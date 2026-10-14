// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PROTECTED_TRACKER_TYPES,
  TEAM_NOTE_BODY_MAX_CHARS,
  TOOL_MANIFEST_BODY_ERROR,
  TOOL_MANIFEST_HAND_CREATE_ERROR,
  assertProtectedTrackerBody,
  assertProtectedTrackerUpdate,
  isProtectedTrackerType,
  prepareProtectedTrackerCreate,
  protectedTrackerTypeChangeError,
  protectedTrackerTypeTagError,
} from "../index";

/** A manifest as the host stores it. */
const manifest = {
  title: "M-1: task",
  status: "draft",
  description: "```yaml\ntoolManifest: 1\nid: M-1\n```",
  manifestId: "M-1",
  manifestVersion: "1",
  teamRootSessionId: "root-1",
  architectSessionId: "arch-1",
  generatedByRole: "architect",
  model: "claude-code:opus",
  confidence: "high",
  contentHash: "0123456789abcdef",
};
/** A note as the app's agent tool stores it (provenance filled by the host). */
const note = {
  title: "Port the rules gradually",
  status: "active",
  noteKind: "decision",
  description: "Decided with the user.",
  sourceSession: "root-1",
  teamRootSession: "root-1",
  agentRole: "coordinator",
};

describe("the protected set", () => {
  it("is team-note and tool-manifest, nothing else", () => {
    expect([...PROTECTED_TRACKER_TYPES]).toEqual(["team-note", "tool-manifest"]);
    expect(isProtectedTrackerType("team-note")).toBe(true);
    expect(isProtectedTrackerType("tool-manifest")).toBe(true);
    for (const type of ["task", "bug", "plan", "decision", "", undefined, null, 42]) expect(isProtectedTrackerType(type), String(type)).toBe(false);
  });

  it("a protected type is never a tag on another item", () => {
    expect(protectedTrackerTypeTagError("task", ["task", "tool-manifest"])).toMatch(/tool-manifest can only be the primary type/);
    expect(protectedTrackerTypeTagError("task", ["team-note"])).toMatch(/team-note can only be the primary type/);
    expect(protectedTrackerTypeTagError("team-note", ["team-note"])).toBeNull();
    expect(protectedTrackerTypeTagError("task", ["task", "feature"])).toBeNull();
    expect(protectedTrackerTypeTagError("task", undefined)).toBeNull();
  });
});

describe("create", () => {
  it("an unprotected type is untouched", () => {
    const data: Record<string, unknown> = { title: "x", status: "to-do" };
    prepareProtectedTrackerCreate("task", data, { body: "y".repeat(10_000) });
    expect(data).toEqual({ title: "x", status: "to-do" });
    expect(() => prepareProtectedTrackerCreate("task", data, { typeTags: ["task", "team-note"] })).toThrow(/not a type tag/);
  });

  it("a tool-manifest is created only by the host, with complete provenance", () => {
    expect(() => prepareProtectedTrackerCreate("tool-manifest", { ...manifest })).toThrow(TOOL_MANIFEST_HAND_CREATE_ERROR);
    expect(() => prepareProtectedTrackerCreate("tool-manifest", { ...manifest }, { provenanceFromHost: true })).toThrow(TOOL_MANIFEST_HAND_CREATE_ERROR);
    const data: Record<string, unknown> = { ...manifest };
    delete data.status;
    prepareProtectedTrackerCreate("tool-manifest", data, { hostOwned: true });
    expect(data.status).toBe("draft");
    expect(data.createdByAgent).toBe(true);
    expect(() => prepareProtectedTrackerCreate("tool-manifest", { ...manifest, architectSessionId: "" }, { hostOwned: true })).toThrow(/architectSessionId must name the session/);
  });

  it("a team-note created by hand gets no provenance, the active status and the manual mark", () => {
    const data: Record<string, unknown> = { title: "x", noteKind: "risk" };
    prepareProtectedTrackerCreate("team-note", data, { body: "short" });
    expect(data).toEqual({ title: "x", noteKind: "risk", status: "active", createdByAgent: false });
    expect(() => prepareProtectedTrackerCreate("team-note", { title: "x", noteKind: "risk", sourceSession: "forged" })).toThrow(/sourceSession is set by Nimbalyst from the agent session/);
    expect(() => prepareProtectedTrackerCreate("team-note", { title: "x" })).toThrow(/needs noteKind/);
    expect(() => prepareProtectedTrackerCreate("team-note", { title: "x", noteKind: "risk" }, { body: "b".repeat(TEAM_NOTE_BODY_MAX_CHARS + 1) })).toThrow(/limit is 600/);
    expect(() => prepareProtectedTrackerCreate("team-note", { title: "x", noteKind: "risk", status: "done" })).toThrow(/status must be one of/);
  });

  it("a team-note whose provenance the host filled from the agent session keeps it and is marked an agent's", () => {
    const data: Record<string, unknown> = { ...note };
    prepareProtectedTrackerCreate("team-note", data, { provenanceFromHost: true, body: "short" });
    expect(data).toEqual({ ...note, createdByAgent: true });
  });
});

describe("update", () => {
  it("an unprotected item changes freely, but never becomes protected", () => {
    expect(() => assertProtectedTrackerUpdate("task", { status: "done", fields: { owner: "me" } }, { status: "to-do" }, { status: "done", owner: "me" })).not.toThrow();
    expect(() => assertProtectedTrackerUpdate("task", { primaryType: "team-note" }, { title: "x" }, { title: "x" })).toThrow(/cannot be turned into a team-note/);
    expect(() => assertProtectedTrackerUpdate("task", { typeTags: ["task", "tool-manifest"] }, { title: "x" }, { title: "x" })).toThrow(/cannot be turned into a tool-manifest/);
  });

  it("a team-note keeps its provenance and its structure, and never changes type", () => {
    expect(() => assertProtectedTrackerUpdate("team-note", { status: "resolved" }, note, { ...note, status: "resolved" })).not.toThrow();
    expect(() => assertProtectedTrackerUpdate("team-note", { fields: { sourceSession: "other" } }, note, { ...note, sourceSession: "other" })).toThrow(/sourceSession records where the note came from and cannot be changed/);
    expect(() => assertProtectedTrackerUpdate("team-note", { status: "done" }, note, { ...note, status: "done" })).toThrow(/status must be one of/);
    expect(() => assertProtectedTrackerUpdate("team-note", { description: "x".repeat(601) }, note, { ...note, description: "x".repeat(601) })).toThrow(/limit is 600/);
    expect(() => assertProtectedTrackerUpdate("team-note", { primaryType: "task" }, note, note)).toThrow(/cannot change type/);
    // The customFields storage shape reads the same.
    expect(() => assertProtectedTrackerUpdate("team-note", { status: "resolved" }, { title: note.title, status: "active", customFields: { ...note } }, { ...note, status: "resolved" })).not.toThrow();
  });

  it("a tool-manifest only moves along its lifecycle; body, title, provenance and supersedes are immutable", () => {
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, manifest, { ...manifest, status: "accepted" })).not.toThrow();
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "superseded" }, { ...manifest, status: "accepted" }, { ...manifest, status: "superseded" })).not.toThrow();
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "draft" }, { ...manifest, status: "accepted" }, { ...manifest, status: "draft" })).toThrow(/never returns to draft/);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, { ...manifest, status: "superseded" }, { ...manifest, status: "accepted" })).toThrow(/stays superseded/);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { description: "edited" }, manifest, { ...manifest, description: "edited" })).toThrow(TOOL_MANIFEST_BODY_ERROR);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { title: "renamed" }, manifest, { ...manifest, title: "renamed" })).toThrow(/title is set by Nimbalyst/);
    for (const field of ["manifestId", "teamRootSessionId", "architectSessionId", "generatedByRole", "manifestVersion", "contentHash"]) {
      expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { [field]: "forged" } }, manifest, { ...manifest, [field]: "forged" }), field).toThrow(new RegExp(`${field} is set by Nimbalyst`));
    }
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: ["other"] } }, manifest, { ...manifest, supersedes: ["other"] })).toThrow(/supersedes is set by Nimbalyst/);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { primaryType: "task" }, manifest, manifest)).toThrow(/cannot change type/);
    // Bookkeeping the tracker adds on every write is not a change.
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, manifest, { ...manifest, status: "accepted", lastModifiedBy: "u", activity: [{}], comments: [{}] })).not.toThrow();
  });

  it("a synced item keeps its provenance nested in customFields: a top-level write that disagrees is a change", () => {
    const { title, status, description, ...provenance } = manifest;
    const synced = { title, status, description, customFields: provenance };
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, synced, { ...synced, status: "accepted" })).not.toThrow();
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { architectSessionId: "me" } }, synced, { ...synced, architectSessionId: "me" })).toThrow(/architectSessionId is set by Nimbalyst/);
    // The same value written at the top level is no change.
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, synced, { ...synced, status: "accepted", architectSessionId: "arch-1" })).not.toThrow();
    const { title: noteTitle, status: noteStatus, description: noteBody, ...noteProvenance } = note;
    const syncedNote = { title: noteTitle, status: noteStatus, description: noteBody, customFields: noteProvenance };
    expect(() => assertProtectedTrackerUpdate("team-note", { fields: { sourceSession: "other" } }, syncedNote, { ...syncedNote, sourceSession: "other" })).toThrow(/sourceSession records where the note came from/);
    expect(() => assertProtectedTrackerUpdate("team-note", { status: "resolved" }, syncedNote, { ...syncedNote, status: "resolved" })).not.toThrow();
  });
});

describe("supersedes is compared by its targets, not by its shape (NIB.29)", () => {
  const refused = /supersedes is set by Nimbalyst/;
  /** The second manifest of a team, as the host stores it: the link as a target id. */
  const superseding = { ...manifest, manifestId: "M-2", title: "M-2: task", supersedes: ["tmf-1"] };
  const withoutLink = (({ supersedes: _link, ...rest }) => rest)(superseding);
  const canonical = [{ itemId: "tmf-1" }];
  const accepted = (data: Record<string, unknown>) => ({ ...data, status: "accepted" });

  it("a status-only accept is allowed whatever shape the write funnel leaves the link in", () => {
    // Shape untouched (the CLI, a plain write).
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, superseding, accepted(superseding))).not.toThrow();
    // The MCP funnel canonicalizes ids to objects and nests them before the rule runs (the refused accept of the 1C pilot).
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, superseding, accepted({ ...withoutLink, customFields: { supersedes: canonical } }))).not.toThrow();
    // The UI funnel nests the ids as they are.
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, superseding, accepted({ ...withoutLink, customFields: { supersedes: ["tmf-1"] } }))).not.toThrow();
    // And back: objects stored, ids written by a re-serialization.
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, { ...withoutLink, customFields: { supersedes: canonical } }, accepted({ ...withoutLink, supersedes: ["tmf-1"] }))).not.toThrow();
    // Duplicates and order are not a change either.
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, { ...withoutLink, supersedes: ["tmf-1", "tmf-0"] }, accepted({ ...withoutLink, supersedes: [{ itemId: "tmf-0" }, { itemId: "tmf-1" }, "tmf-1"] }))).not.toThrow();
  });

  it("another target, one more, one fewer or none at all is a change and is refused, in either shape", () => {
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: ["tmf-9"] } }, superseding, { ...superseding, supersedes: ["tmf-9"] })).toThrow(refused);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: [{ itemId: "tmf-9" }] } }, superseding, { ...superseding, supersedes: [{ itemId: "tmf-9" }] })).toThrow(refused);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: ["tmf-1", "tmf-2"] } }, superseding, { ...superseding, supersedes: ["tmf-1", "tmf-2"] })).toThrow(refused);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: [] } }, superseding, { ...superseding, supersedes: [] })).toThrow(refused);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { unsetFields: ["supersedes"] }, superseding, withoutLink)).toThrow(refused);
    // A manifest that replaced nothing cannot be given a link.
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: ["tmf-1"] } }, manifest, { ...manifest, supersedes: ["tmf-1"] })).toThrow(refused);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: canonical } }, manifest, { ...manifest, supersedes: canonical })).toThrow(refused);
  });

  it("a top-level shadow naming other targets is refused; the same targets in another shape are not a shadow", () => {
    const synced = { ...withoutLink, customFields: { supersedes: ["tmf-1"] } };
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, synced, { ...synced, status: "accepted", supersedes: canonical })).not.toThrow();
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, synced, { ...synced, status: "accepted", supersedes: ["tmf-9"] })).toThrow(refused);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: ["tmf-9"] } }, synced, { ...synced, supersedes: ["tmf-9"] })).toThrow(refused);
  });

  it("entries that name no target are not the same link in another shape: compared as they are, like before (reviewer case)", () => {
    for (const garbage of [[{ title: "x" }], [{}], [123], [{ itemId: "" }], [""]]) {
      // On a manifest without a link, garbage is not "no targets": refused, as it was before.
      expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: garbage } }, manifest, { ...manifest, supersedes: garbage }), JSON.stringify(garbage)).toThrow(refused);
      expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, manifest, { ...manifest, status: "accepted", customFields: { supersedes: garbage } }), JSON.stringify(garbage)).toThrow(refused);
      // Next to a real target it is not the same link either.
      expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { supersedes: [canonical[0], ...garbage] } }, superseding, { ...superseding, supersedes: [canonical[0], ...garbage] }), JSON.stringify(garbage)).toThrow(refused);
    }
    // A value stored as is and left as is is no change, whatever it holds.
    const odd = { ...withoutLink, supersedes: [{ title: "x" }] };
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "accepted" }, odd, accepted(odd))).not.toThrow();
  });

  it("leaves the other immutable fields, the body and the lifecycle exactly as strict", () => {
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { manifestId: "M-9" } }, superseding, { ...superseding, manifestId: "M-9" })).toThrow(/manifestId is set by Nimbalyst/);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { fields: { architectSessionId: "me" } }, superseding, { ...superseding, architectSessionId: "me" })).toThrow(/architectSessionId is set by Nimbalyst/);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { description: "edited" }, superseding, { ...superseding, description: "edited" })).toThrow(TOOL_MANIFEST_BODY_ERROR);
    expect(() => assertProtectedTrackerUpdate("tool-manifest", { status: "draft" }, accepted(superseding), superseding)).toThrow(/never returns to draft/);
    // A team-note has no relationship field: its rules are untouched.
    expect(() => assertProtectedTrackerUpdate("team-note", { fields: { sourceSession: "other" } }, note, { ...note, sourceSession: "other" })).toThrow(/sourceSession records where the note came from/);
    expect(() => assertProtectedTrackerUpdate("team-note", { status: "resolved" }, note, { ...note, status: "resolved" })).not.toThrow();
  });
});

describe("body and type change", () => {
  it("a team-note body is capped, a tool-manifest body is never edited, other bodies are free", () => {
    expect(() => assertProtectedTrackerBody("task", "x".repeat(50_000))).not.toThrow();
    expect(() => assertProtectedTrackerBody("team-note", "x".repeat(600))).not.toThrow();
    expect(() => assertProtectedTrackerBody("team-note", "x".repeat(601))).toThrow(/limit is 600/);
    expect(() => assertProtectedTrackerBody("tool-manifest", "anything")).toThrow(TOOL_MANIFEST_BODY_ERROR);
  });

  it("names the type change a write would make", () => {
    expect(protectedTrackerTypeChangeError("team-note", "task", undefined)).toMatch(/team-note cannot change type/);
    expect(protectedTrackerTypeChangeError("tool-manifest", "task", undefined)).toMatch(/tool-manifest cannot change type/);
    expect(protectedTrackerTypeChangeError("task", "team-note", undefined)).toMatch(/cannot be turned into a team-note/);
    expect(protectedTrackerTypeChangeError("task", undefined, ["task", "tool-manifest"])).toMatch(/cannot be turned into a tool-manifest/);
    expect(protectedTrackerTypeChangeError("task", "bug", ["bug"])).toBeNull();
  });
});
