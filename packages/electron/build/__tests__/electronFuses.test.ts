// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createRequire } from "module";

const require_ = createRequire(import.meta.url);
const packageJson = require_("../../package.json");

// NIB.97/U8: a packaged build must not accept `--inspect` / `--inspect-brk` on its command line.
// The Chromium switches are removed in bootstrap.ts, but the Node inspector reads its flags before
// any app JavaScript runs, so only the EnableNodeCliInspectArguments fuse closes it. Only that fuse
// is flipped: RunAsNode in particular is used by the app (ELECTRON_RUN_AS_NODE hooks).
describe("Electron fuses in the packaging config", () => {
  it("flips only EnableNodeCliInspectArguments, to false", () => {
    expect(packageJson.build.electronFuses).toEqual({ enableNodeCliInspectArguments: false });
  });

  it("maps to exactly one fuse in electron-builder's own translation to @electron/fuses", async () => {
    const { PlatformPackager } = require_("app-builder-lib");
    const { FuseV1Options, FuseVersion } = await import("@electron/fuses");
    // generateFuseConfig does not use `this`
    const config = await PlatformPackager.prototype.generateFuseConfig.call({}, packageJson.build.electronFuses);
    const flipped = Object.keys(config).filter((key) => key !== "version" && key !== "resetAdHocDarwinSignature");
    expect(config.version).toBe(FuseVersion.V1);
    expect(flipped).toEqual([String(FuseV1Options.EnableNodeCliInspectArguments)]);
    expect(config[FuseV1Options.EnableNodeCliInspectArguments]).toBe(false);
    expect(config[FuseV1Options.RunAsNode]).toBeUndefined();
  });

  it("keeps the app's own use of ELECTRON_RUN_AS_NODE possible (RunAsNode is not configured)", () => {
    expect(packageJson.build.electronFuses.runAsNode).toBeUndefined();
  });
});
