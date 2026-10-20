import { describe, expect, it } from "vitest";
import { MOCKUP_FRAME_SANDBOX } from "../utils/mockupFrameSandbox";

describe("MOCKUP_FRAME_SANDBOX", () => {
  it("is exactly allow-same-origin, so mockup scripts and inline handlers never run", () => {
    expect(MOCKUP_FRAME_SANDBOX).toBe("allow-same-origin");
  });
});
