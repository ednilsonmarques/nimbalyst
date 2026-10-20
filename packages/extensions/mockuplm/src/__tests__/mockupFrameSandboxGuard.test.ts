import { describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * A new mockup frame added next to the five that exist must not slip back to a
 * literal `allow-scripts` sandbox (or none at all). Every `<iframe` in the
 * extension's components has to take its sandbox from MOCKUP_FRAME_SANDBOX.
 */

const SRC = path.resolve(__dirname, "..");

function tsxFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : tsxFiles(full);
    return entry.name.endsWith(".tsx") ? [full] : [];
  });
}

/** Source text of every `<iframe ... />` element that does not use the shared constant. */
function badIframes(src: string): string[] {
  const bad: string[] = [];
  for (const m of src.matchAll(/<iframe\b/g)) {
    const end = src.indexOf("/>", m.index!);
    const element = end < 0 ? src.slice(m.index!) : src.slice(m.index!, end + 2);
    if (!/\bsandbox=\{MOCKUP_FRAME_SANDBOX\}/.test(element)) bad.push(element.replace(/\s+/g, " "));
  }
  return bad;
}

describe("every MockupLM iframe takes its sandbox from MOCKUP_FRAME_SANDBOX", () => {
  it("finds the frames (guard against scanning nothing)", () => {
    const total = tsxFiles(SRC).reduce(
      (n, f) => n + (fs.readFileSync(f, "utf8").match(/<iframe\b/g)?.length ?? 0),
      0
    );
    expect(total).toBe(5);
  });

  it("has no literal or missing sandbox in src/**/*.tsx", () => {
    const offenders = tsxFiles(SRC).flatMap((f) =>
      badIframes(fs.readFileSync(f, "utf8")).map((el) => `${path.relative(SRC, f)}: ${el}`)
    );
    expect(offenders).toEqual([]);
  });
});

describe("the iframe check itself (broken in-memory inputs)", () => {
  it("accepts the constant", () => {
    expect(badIframes('<iframe title="a" sandbox={MOCKUP_FRAME_SANDBOX} className="x" />')).toEqual([]);
  });

  it("flags a literal that allows scripts", () => {
    expect(badIframes('<iframe sandbox="allow-scripts allow-same-origin" title="a" />')).toHaveLength(1);
  });

  it("flags a harmless-looking literal too (the constant is the only source)", () => {
    expect(badIframes('<iframe sandbox="allow-same-origin" />')).toHaveLength(1);
  });

  it("flags a missing sandbox", () => {
    expect(badIframes('<iframe title="a" className="x" />')).toHaveLength(1);
  });

  it("flags the bad one among good ones", () => {
    const mixed = '<iframe sandbox={MOCKUP_FRAME_SANDBOX} />\n<iframe\n  title="b"\n/>';
    expect(badIframes(mixed)).toHaveLength(1);
  });
});
