// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PROTECTED_TRACKER_TYPES,
  TEAM_FRONT_AGENT_CREATE_ERROR,
  TEAM_FRONT_AGENT_EDITABLE_FIELDS,
  TEAM_FRONT_DESCRIPTION_MAX_CHARS,
  TEAM_FRONT_HOST_FIELDS,
  TEAM_FRONT_STATE_ERROR,
  TEAM_FRONT_STATUSES,
  TEAM_FRONT_TYPE,
  assertProtectedTrackerBody,
  assertProtectedTrackerUpdate,
  assertTeamFrontBody,
  assertTeamFrontUpdate,
  isProtectedTrackerType,
  prepareManualTeamFrontCreate,
  prepareProtectedTrackerCreate,
  prepareTeamFrontCreate,
  protectedTrackerTypeChangeError,
  teamFrontAgentUpdateError,
  readTeamFrontField,
  teamFrontTypeChangeError,
  validateTeamFrontData,
} from "../index";

/** A front as the user's UI stores it. */
const front = {
  title: "Team Mode",
  status: "active",
  description: "Objetivo: ciclo de vida. Autoridade: ESTADO.md.",
};
const agent = { agent: true } as const;
const host = { hostOwned: true } as const;

describe("the team-front contract", () => {
  it("fixes the type, the statuses, the cap and who owns which field", () => {
    expect(TEAM_FRONT_TYPE).toBe("team-front");
    expect([...TEAM_FRONT_STATUSES]).toEqual(["active", "paused", "closed"]);
    expect(TEAM_FRONT_DESCRIPTION_MAX_CHARS).toBe(2000);
    expect([...TEAM_FRONT_HOST_FIELDS]).toEqual(["currentMission"]);
    expect([...TEAM_FRONT_AGENT_EDITABLE_FIELDS]).toEqual(["description"]);
  });

  it("is a protected type, appended to the closed list", () => {
    expect(isProtectedTrackerType("team-front")).toBe(true);
    expect([...PROTECTED_TRACKER_TYPES]).toContain("team-front");
  });

  it("reads a field from the top level or from the synced customFields bag", () => {
    expect(readTeamFrontField({ currentMission: "a" }, "currentMission")).toBe("a");
    expect(readTeamFrontField({ customFields: { currentMission: "b" }, currentMission: "a" }, "currentMission")).toBe("b");
    expect(readTeamFrontField(null, "currentMission")).toBeUndefined();
  });
});

describe("create: fronts are made by the user, never by an agent", () => {
  it("a front created by hand (UI, IPC, CLI) gets the active status and the manual mark", () => {
    const data: Record<string, unknown> = { title: "Portal", description: "Estado do Portal." };
    prepareManualTeamFrontCreate("team-front", data);
    expect(data).toEqual({ title: "Portal", description: "Estado do Portal.", status: "active", createdByAgent: false });
  });

  it("an agent's tracker_create of a front is refused whatever it carries", () => {
    expect(() => prepareTeamFrontCreate("team-front", { ...front }, undefined, agent)).toThrow(TEAM_FRONT_AGENT_CREATE_ERROR);
    expect(() => prepareProtectedTrackerCreate("team-front", { ...front }, { provenanceFromHost: true })).toThrow(TEAM_FRONT_AGENT_CREATE_ERROR);
    // The host's own persistence is not the agent path either, but nobody creates a front on the agent's behalf.
    expect(() => prepareTeamFrontCreate("team-front", { ...front }, undefined, { agent: true, hostOwned: true })).toThrow(TEAM_FRONT_AGENT_CREATE_ERROR);
  });

  it("says where the user creates a front: the Tracker UI or the OFFLINE nim CLI (with the app open, nim goes through the agent path)", () => {
    expect(TEAM_FRONT_AGENT_CREATE_ERROR).toMatch(/Tracker UI/);
    expect(TEAM_FRONT_AGENT_CREATE_ERROR).toMatch(/offline nim CLI/);
    expect(TEAM_FRONT_AGENT_CREATE_ERROR).not.toMatch(/UI or the nim CLI/);
    expect(TEAM_FRONT_AGENT_CREATE_ERROR.length).toBeLessThan(260);
  });

  it("a writer anyone can reach, with no host-filled provenance (a file's frontmatter, a page tool), passes `agent`: the same rules refuse every protected type", () => {
    expect(() => prepareProtectedTrackerCreate("team-front", { ...front }, { agent: true })).toThrow(TEAM_FRONT_AGENT_CREATE_ERROR);
    expect(() => prepareProtectedTrackerCreate("tool-manifest", { title: "M-9", manifestId: "M-9" }, { agent: true })).toThrow(/written by Nimbalyst when an architect session completes/);
    // A note carries no provenance it was not given by the host: forging it is refused.
    expect(() => prepareProtectedTrackerCreate("team-note", { title: "n", noteKind: "risk", sourceSession: "forged" }, { agent: true })).toThrow(/sourceSession is set by Nimbalyst/);
    // An ordinary type is untouched.
    const data: Record<string, unknown> = { title: "x" };
    prepareProtectedTrackerCreate("task", data, { agent: true });
    expect(data).toEqual({ title: "x" });
  });

  it("goes through the single protected entry point", () => {
    const data: Record<string, unknown> = { title: "Portal" };
    prepareProtectedTrackerCreate("team-front", data, { body: "short" });
    expect(data).toEqual({ title: "Portal", status: "active", createdByAgent: false });
  });

  it("needs a title and one of the three statuses", () => {
    expect(() => prepareManualTeamFrontCreate("team-front", {})).toThrow(/needs a title/);
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "   " })).toThrow(/needs a title/);
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x", status: "done" })).toThrow(/status must be one of: active, paused, closed/);
    for (const status of TEAM_FRONT_STATUSES) {
      expect(() => prepareManualTeamFrontCreate("team-front", { title: "x", status, description: "Estado." }), status).not.toThrow();
    }
  });

  it("caps the description (the state of the front) and a rich body at 2,000 characters", () => {
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x", description: "d".repeat(2000) })).not.toThrow();
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x", description: "d".repeat(2001) })).toThrow(/limit is 2000/);
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x" }, "b".repeat(2000))).not.toThrow();
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x" }, "b".repeat(2001))).toThrow(/limit is 2000/);
  });

  it("currentMission is the host's: nobody sets it on create, and only the host's persistence may", () => {
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x", currentMission: "root-1" })).toThrow(/currentMission is set by Nimbalyst/);
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x", customFields: { currentMission: "root-1" } })).toThrow(/currentMission is set by Nimbalyst/);
    expect(() => prepareTeamFrontCreate("team-front", { title: "x", description: "Estado.", currentMission: "root-1" }, undefined, host)).not.toThrow();
  });

  it("another type is untouched", () => {
    const data: Record<string, unknown> = { title: "x" };
    prepareTeamFrontCreate("task", data, "y".repeat(10_000), agent);
    expect(data).toEqual({ title: "x" });
  });
});

describe("the state of a front is required: a description or a body (user decision 2026-10-23)", () => {
  it("has a short, precise message", () => {
    expect(TEAM_FRONT_STATE_ERROR).toBe("A team-front needs its state: write a description or a body.");
  });

  it("create with neither a description nor a body is refused", () => {
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal" })).toThrow(TEAM_FRONT_STATE_ERROR);
    expect(() => prepareProtectedTrackerCreate("team-front", { title: "Portal" })).toThrow(TEAM_FRONT_STATE_ERROR);
    expect(() => prepareProtectedTrackerCreate("team-front", { title: "Portal" }, { body: null })).toThrow(TEAM_FRONT_STATE_ERROR);
    expect(() => prepareProtectedTrackerCreate("team-front", { title: "Portal", description: "" }, { body: "" })).toThrow(TEAM_FRONT_STATE_ERROR);
  });

  it("whitespace is not a state, in the description or the body, as text or as an empty rich document", () => {
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal", description: "  \n\t " })).toThrow(TEAM_FRONT_STATE_ERROR);
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal" }, "   \n ")).toThrow(TEAM_FRONT_STATE_ERROR);
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal", description: " " }, "  ")).toThrow(TEAM_FRONT_STATE_ERROR);
    // An empty Lexical document, as the body editor saves it.
    const empty = { root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text: "  " }] }] } };
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal" }, empty)).toThrow(TEAM_FRONT_STATE_ERROR);
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal" }, JSON.stringify(empty))).toThrow(TEAM_FRONT_STATE_ERROR);
  });

  it("a description alone is a state", () => {
    const data: Record<string, unknown> = { title: "Portal", description: "Estado." };
    expect(() => prepareManualTeamFrontCreate("team-front", data)).not.toThrow();
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal", description: "Estado." }, "")).not.toThrow();
  });

  it("a body alone is a state: text, a JSON-quoted string as the column stores it, or a rich document", () => {
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal" }, "Estado no corpo.")).not.toThrow();
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal" }, JSON.stringify("Estado no corpo."))).not.toThrow();
    const rich = { root: { type: "root", children: [{ type: "paragraph", children: [{ type: "text", text: "Estado." }] }] } };
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal" }, rich)).not.toThrow();
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "Portal" }, JSON.stringify(rich))).not.toThrow();
    expect(() => prepareProtectedTrackerCreate("team-front", { title: "Portal" }, { body: "Estado no corpo." })).not.toThrow();
  });

  it("the 2,000-character cap keeps applying to both, alone or together", () => {
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x", description: "d".repeat(2001) }, "ok")).toThrow(/limit is 2000/);
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x", description: "ok" }, "b".repeat(2001))).toThrow(/limit is 2000/);
    expect(() => prepareManualTeamFrontCreate("team-front", { title: "x" }, "b".repeat(2000))).not.toThrow();
  });

  it("other types are not asked for a state", () => {
    expect(() => prepareTeamFrontCreate("task", { title: "x" }, undefined)).not.toThrow();
  });

  it("validateTeamFrontData reports the missing state with the other problems", () => {
    expect(validateTeamFrontData({ title: "x", status: "active" }, { mode: "create" })).toEqual([TEAM_FRONT_STATE_ERROR]);
    expect(validateTeamFrontData({ title: "x", status: "active" }, { mode: "create", body: "estado" })).toEqual([]);
  });

  describe("update", () => {
    const stored = { ...front, currentMission: "root-1" };
    const cleared = { ...stored, description: "" };

    it("clearing the description is refused when the stored body is empty, for the user and the agent", () => {
      expect(() => assertTeamFrontUpdate("team-front", { description: "" }, stored, cleared, { storedBody: null })).toThrow(TEAM_FRONT_STATE_ERROR);
      expect(() => assertTeamFrontUpdate("team-front", { description: "  " }, stored, { ...stored, description: "  " }, { storedBody: "" })).toThrow(TEAM_FRONT_STATE_ERROR);
      expect(() => assertTeamFrontUpdate("team-front", { id: "x", description: "" }, stored, cleared, { agent: true, storedBody: null })).toThrow(TEAM_FRONT_STATE_ERROR);
      expect(() => assertProtectedTrackerUpdate("team-front", { description: "" }, stored, cleared, { storedBody: null })).toThrow(TEAM_FRONT_STATE_ERROR);
    });

    it("clearing the description is fine when the body holds the state", () => {
      expect(() => assertTeamFrontUpdate("team-front", { description: "" }, stored, cleared, { storedBody: "Estado no corpo." })).not.toThrow();
      expect(() => assertTeamFrontUpdate("team-front", { description: "" }, stored, cleared, { storedBody: JSON.stringify("Estado no corpo.") })).not.toThrow();
    });

    it("an update that leaves a description is fine whatever the body", () => {
      expect(() => assertTeamFrontUpdate("team-front", { description: "novo" }, stored, { ...stored, description: "novo" }, { storedBody: null })).not.toThrow();
      expect(() => assertTeamFrontUpdate("team-front", { status: "paused" }, stored, { ...stored, status: "paused" }, { storedBody: null })).not.toThrow();
    });

    it("a funnel that cannot see the body does not guess: the accepted gap, nothing is refused", () => {
      expect(() => assertTeamFrontUpdate("team-front", { description: "" }, stored, cleared)).not.toThrow();
      expect(() => assertProtectedTrackerUpdate("team-front", { description: "" }, stored, cleared)).not.toThrow();
    });

    it("a funnel that writes the body together with the description is judged on the resulting pair, even when the description stays empty", () => {
      // A front whose state is only its body: the caller sends an empty description and the funnel overwrites the body with it.
      const bodyOnly = { ...stored, description: "" };
      for (const sent of ["", "   "]) {
        expect(() => assertTeamFrontUpdate("team-front", { description: sent }, bodyOnly, { ...bodyOnly, description: sent }, { storedBody: sent, writesBody: true }), JSON.stringify(sent)).toThrow(TEAM_FRONT_STATE_ERROR);
        expect(() => assertProtectedTrackerUpdate("team-front", { description: sent }, bodyOnly, { ...bodyOnly, description: sent }, { storedBody: sent, writesBody: true })).toThrow(TEAM_FRONT_STATE_ERROR);
        expect(() => assertTeamFrontUpdate("team-front", { id: "x", description: sent }, bodyOnly, { ...bodyOnly, description: sent }, { agent: true, storedBody: sent, writesBody: true })).toThrow(TEAM_FRONT_STATE_ERROR);
      }
      // A real description replaces the body and is the state.
      expect(() => assertTeamFrontUpdate("team-front", { description: "Estado." }, bodyOnly, { ...bodyOnly, description: "Estado." }, { storedBody: "Estado.", writesBody: true })).not.toThrow();
      // Without the flag the funnel keeps its body, so an unchanged empty description is not judged here.
      expect(() => assertTeamFrontUpdate("team-front", { description: "" }, bodyOnly, { ...bodyOnly }, { storedBody: "Estado da frente" })).not.toThrow();
      // A write that touches neither description nor body leaves a legacy front alone.
      const legacy = { title: "Old", status: "active" };
      expect(() => assertTeamFrontUpdate("team-front", { title: "New" }, legacy, { ...legacy, title: "New" }, { storedBody: null })).not.toThrow();
    });

    it("an update that does not touch the description does not refuse a front that already lacks a state (synced from an older peer)", () => {
      const legacy = { title: "Old", status: "active" };
      expect(() => assertTeamFrontUpdate("team-front", { status: "paused" }, legacy, { ...legacy, status: "paused" }, { storedBody: null })).not.toThrow();
    });

    it("saving an empty body is refused when the description is empty too, and fine otherwise", () => {
      expect(() => assertTeamFrontBody("team-front", "", { description: "" })).toThrow(TEAM_FRONT_STATE_ERROR);
      expect(() => assertTeamFrontBody("team-front", null, { description: undefined })).toThrow(TEAM_FRONT_STATE_ERROR);
      expect(() => assertProtectedTrackerBody("team-front", "  ", { description: " " })).toThrow(TEAM_FRONT_STATE_ERROR);
      expect(() => assertTeamFrontBody("team-front", "", { description: "Estado." })).not.toThrow();
      expect(() => assertTeamFrontBody("team-front", "Estado.", { description: "" })).not.toThrow();
      // Without any item in view, only the cap is checked (the gap).
      expect(() => assertTeamFrontBody("team-front", "")).not.toThrow();
    });

    it("an item context that lacks `description` is still judged: a caller cannot skip the state check by omission (a missing description reads as empty)", () => {
      expect(() => assertTeamFrontBody("team-front", "", {})).toThrow(TEAM_FRONT_STATE_ERROR);
      expect(() => assertTeamFrontBody("team-front", "  ", { noteKind: "decision" } as never)).toThrow(TEAM_FRONT_STATE_ERROR);
      expect(() => assertProtectedTrackerBody("team-front", "", { noteKind: "decision" })).toThrow(TEAM_FRONT_STATE_ERROR);
      expect(() => assertProtectedTrackerBody("team-front", null, {})).toThrow(TEAM_FRONT_STATE_ERROR);
      // A body that says something is a state by itself.
      expect(() => assertProtectedTrackerBody("team-front", "Estado.", { noteKind: "decision" })).not.toThrow();
      // And other types never read it.
      expect(() => assertProtectedTrackerBody("task", "", {})).not.toThrow();
    });
  });
});

describe("update", () => {
  const stored = { ...front, currentMission: "root-1" };

  it("the user edits title, status and description freely", () => {
    expect(() => assertTeamFrontUpdate("team-front", { title: "Team Mode 2" }, stored, { ...stored, title: "Team Mode 2" })).not.toThrow();
    for (const status of TEAM_FRONT_STATUSES) {
      expect(() => assertTeamFrontUpdate("team-front", { status }, stored, { ...stored, status }), status).not.toThrow();
    }
    expect(() => assertTeamFrontUpdate("team-front", { description: "novo" }, stored, { ...stored, description: "novo" })).not.toThrow();
  });

  it("refuses a status outside active, paused and closed, an empty title and a description over the cap", () => {
    expect(() => assertTeamFrontUpdate("team-front", { status: "done" }, stored, { ...stored, status: "done" })).toThrow(/status must be one of/);
    expect(() => assertTeamFrontUpdate("team-front", { title: "" }, stored, { ...stored, title: "" })).toThrow(/needs a title/);
    expect(() => assertTeamFrontUpdate("team-front", { description: "x".repeat(2001) }, stored, { ...stored, description: "x".repeat(2001) })).toThrow(/limit is 2000/);
  });

  it("currentMission is the host's: neither the user nor an agent changes it, the host does", () => {
    const moved = { ...stored, currentMission: "root-2" };
    expect(() => assertTeamFrontUpdate("team-front", { fields: { currentMission: "root-2" } }, stored, moved)).toThrow(/currentMission is set by Nimbalyst/);
    expect(() => assertTeamFrontUpdate("team-front", { fields: { currentMission: "root-2" } }, stored, moved, agent)).toThrow(/currentMission is set by Nimbalyst/);
    expect(() => assertTeamFrontUpdate("team-front", { unsetFields: ["currentMission"] }, stored, { ...front })).toThrow(/currentMission is set by Nimbalyst/);
    expect(() => assertTeamFrontUpdate("team-front", { fields: { currentMission: "root-2" } }, stored, moved, host)).not.toThrow();
    expect(() => assertTeamFrontUpdate("team-front", { fields: { currentMission: null } }, stored, { ...front }, host)).not.toThrow();
    // Writing the value it already has changes nothing.
    expect(() => assertTeamFrontUpdate("team-front", { fields: { currentMission: "root-1" } }, stored, stored)).not.toThrow();
    // A host write is not a licence for the agent: the host flag never relaxes the agent restrictions.
    expect(() => assertTeamFrontUpdate("team-front", { title: "x" }, stored, { ...stored, title: "x" }, { agent: true, hostOwned: true })).toThrow(/only the description of a team-front; refused: title\. /);
  });

  it("reads currentMission in both storage shapes: a top-level write that disagrees with customFields is a change", () => {
    const synced = { title: front.title, status: front.status, description: front.description, customFields: { currentMission: "root-1" } };
    expect(() => assertTeamFrontUpdate("team-front", { status: "paused" }, synced, { ...synced, status: "paused" })).not.toThrow();
    expect(() => assertTeamFrontUpdate("team-front", { fields: { currentMission: "root-9" } }, synced, { ...synced, currentMission: "root-9" })).toThrow(/currentMission is set by Nimbalyst/);
    // The same value at the top level is no change.
    expect(() => assertTeamFrontUpdate("team-front", { status: "paused" }, synced, { ...synced, status: "paused", currentMission: "root-1" })).not.toThrow();
    // A front that had none cannot be given one in the other shape either.
    const none = { title: front.title, status: front.status, customFields: {} };
    expect(() => assertTeamFrontUpdate("team-front", { fields: { currentMission: "root-9" } }, none, { ...none, currentMission: "root-9" })).toThrow(/currentMission is set by Nimbalyst/);
  });

  describe("an agent (the coordinator) may update only the description", () => {
    it("allows the description, as an argument or in the fields bag, with the tracker's own bookkeeping", () => {
      const after = { ...stored, description: "novo estado", lastModifiedBy: "u", activity: [{}], comments: [{}] };
      expect(() => assertTeamFrontUpdate("team-front", { id: "x", description: "novo estado" }, stored, after, agent)).not.toThrow();
      expect(() => assertTeamFrontUpdate("team-front", { id: "x", fields: { description: "novo estado" } }, stored, after, agent)).not.toThrow();
      expect(() => assertTeamFrontUpdate("team-front", { id: "x", description: "novo", typeTags: ["team-front"], primaryType: undefined }, stored, { ...stored, description: "novo" }, agent)).not.toThrow();
    });

    it("refuses title, status and anything else, naming each refused key, whether asked as an argument or in the fields bag", () => {
      const refused = (keys: string) => new RegExp(`^An agent may update only the description of a team-front; refused: ${keys}\\. `);
      const attempts: Array<[Record<string, unknown>, Record<string, unknown>, string]> = [
        [{ id: "x", title: "renamed" }, { ...stored, title: "renamed" }, "title"],
        [{ id: "x", status: "closed" }, { ...stored, status: "closed" }, "status"],
        [{ id: "x", fields: { status: "closed" } }, { ...stored, status: "closed" }, "fields\\.status"],
        [{ id: "x", fields: { description: "ok", owner: "me" } }, { ...stored, owner: "me" }, "fields\\.owner"],
        [{ id: "x", priority: "high" }, { ...stored, priority: "high" }, "priority"],
        [{ id: "x", archived: true }, stored, "archived"],
        [{ id: "x", linkSession: "s-1" }, stored, "linkSession"],
        [{ id: "x", published: true }, stored, "published"],
        [{ id: "x", unsetFields: ["description"] }, { title: front.title, status: front.status, currentMission: "root-1" }, "unsetFields"],
        [{ id: "x", typeTags: ["team-front", "task"] }, stored, "typeTags"],
        [{ id: "x", primaryType: "task" }, stored, "primaryType"],
        [{ id: "x", fields: "nope" }, stored, "fields"],
        // Several at once: every refused key is named, in the order asked.
        [{ id: "x", title: "renamed", linkSession: "s-1", fields: { owner: "me", status: "closed" } }, { ...stored, title: "renamed" }, "title, linkSession, fields\\.owner, fields\\.status"],
      ];
      for (const [updates, after, keys] of attempts) {
        expect(() => assertTeamFrontUpdate("team-front", updates, stored, after, agent), JSON.stringify(updates)).toThrow(refused(keys));
      }
    });

    it("refuses a change of title or status even when the arguments do not show it, and says which", () => {
      expect(() => assertTeamFrontUpdate("team-front", { id: "x", description: "novo" }, stored, { ...stored, description: "novo", title: "sneaked" }, agent)).toThrow(/refused: title\. /);
      expect(() => assertTeamFrontUpdate("team-front", { id: "x", description: "novo" }, stored, { ...stored, description: "novo", status: "closed" }, agent)).toThrow(/refused: status\. /);
    });

    it("still applies the cap to the description", () => {
      expect(() => assertTeamFrontUpdate("team-front", { id: "x", description: "x".repeat(2001) }, stored, { ...stored, description: "x".repeat(2001) }, agent)).toThrow(/limit is 2000/);
    });
  });

  it("a front never changes type and nothing becomes one", () => {
    expect(() => assertTeamFrontUpdate("team-front", { type: "task" }, stored, stored)).toThrow(/cannot change type/);
    expect(() => assertTeamFrontUpdate("task", { type: "team-front" }, { title: "x" }, { title: "x" })).toThrow(/cannot be turned into a team-front/);
    expect(() => assertTeamFrontUpdate("task", { typeTags: ["task", "team-front"] }, { title: "x" }, { title: "x" })).toThrow(/cannot be turned into a team-front/);
    expect(teamFrontTypeChangeError("team-front", "task", undefined)).toMatch(/team-front cannot change type/);
    expect(teamFrontTypeChangeError("task", "bug", ["bug"])).toBeNull();
    expect(protectedTrackerTypeChangeError("task", undefined, ["task", "team-front"])).toMatch(/cannot be turned into a team-front/);
  });

  it("another type is untouched by the agent rule", () => {
    expect(() => assertTeamFrontUpdate("task", { id: "x", title: "y", status: "done" }, { title: "x" }, { title: "y" }, agent)).not.toThrow();
  });

  it("goes through the single protected entry point, with the agent flag", () => {
    expect(() => assertProtectedTrackerUpdate("team-front", { status: "paused" }, stored, { ...stored, status: "paused" })).not.toThrow();
    expect(() => assertProtectedTrackerUpdate("team-front", { id: "x", status: "paused" }, stored, { ...stored, status: "paused" }, { agent: true })).toThrow(/only the description of a team-front; refused: status\. /);
    expect(() => assertProtectedTrackerUpdate("team-front", { id: "x", description: "novo" }, stored, { ...stored, description: "novo" }, { agent: true })).not.toThrow();
    // The existing types keep their rules untouched by the new option.
    const note = { title: "n", status: "active", noteKind: "decision", sourceSession: "r" };
    expect(() => assertProtectedTrackerUpdate("team-note", { status: "resolved" }, note, { ...note, status: "resolved" }, { agent: true })).not.toThrow();
  });
});

describe("validateTeamFrontData", () => {
  it("returns every problem at once", () => {
    const problems = validateTeamFrontData({ status: "done", description: "x".repeat(2001), currentMission: "r" }, { mode: "create" });
    expect(problems).toHaveLength(4);
  });

  it("is empty for a valid front", () => {
    expect(validateTeamFrontData(front, { mode: "create" })).toEqual([]);
    expect(validateTeamFrontData(front, { mode: "update", before: front })).toEqual([]);
  });
});

describe("body", () => {
  it("a front's body is capped at 2,000 characters, other bodies are free", () => {
    expect(() => assertTeamFrontBody("team-front", "x".repeat(2000))).not.toThrow();
    expect(() => assertTeamFrontBody("team-front", "x".repeat(2001))).toThrow(/limit is 2000/);
    expect(() => assertTeamFrontBody("task", "x".repeat(50_000))).not.toThrow();
    expect(() => assertProtectedTrackerBody("team-front", "x".repeat(2001))).toThrow(/limit is 2000/);
    expect(() => assertProtectedTrackerBody("team-front", "x".repeat(2000))).not.toThrow();
  });
});

describe("F1.1: the refusal messages name the proposal tool; the rule itself is unchanged", () => {
  it("the create and update refusals point a coordinator to team_front_propose", () => {
    expect(TEAM_FRONT_AGENT_CREATE_ERROR).toMatch(/team_front_propose/);
    expect(teamFrontAgentUpdateError(["status"])).toMatch(/team_front_propose/);
    // still the user's: an agent is refused, and the message still names what was refused
    expect(teamFrontAgentUpdateError(["status", "title"])).toMatch(/refused: status, title\./);
    expect(teamFrontAgentUpdateError(["status"])).toMatch(/currentMission is Nimbalyst's/);
  });

  it("an agent still cannot create a front or change its title or status, with or without hostOwned", () => {
    expect(() => prepareTeamFrontCreate("team-front", { title: "T", status: "active", description: "d" }, undefined, { agent: true })).toThrow(TEAM_FRONT_AGENT_CREATE_ERROR);
    expect(() => prepareTeamFrontCreate("team-front", { title: "T", status: "active", description: "d" }, undefined, { agent: true, hostOwned: true })).toThrow(TEAM_FRONT_AGENT_CREATE_ERROR);
    expect(TEAM_FRONT_AGENT_EDITABLE_FIELDS).toEqual(["description"]);
  });
});
