import {
  convertMockupProjectToCanvas,
  parseCanvasDocument,
  serializeCanvasDocument,
  type MockupProjectCanvasSource,
} from "@nimbalyst/runtime/canvas";
import type { EditorHostFileSystem } from "@nimbalyst/runtime";
import { t as translate } from "@nimbalyst/runtime/i18n";

export type MockupProjectConversionErrorCode =
  | "invalid-source-path"
  | "source-missing"
  | "target-exists"
  | "suspect-conversion"
  | "verification-failed";

export class MockupProjectConversionError extends Error {
  constructor(
    readonly code: MockupProjectConversionErrorCode,
    message: string
  ) {
    super(message);
    this.name = "MockupProjectConversionError";
  }
}

export interface MockupProjectConversionResult {
  sourcePath: string;
  targetPath: string;
  canvasContent: string;
}

export function canvasPathForMockupProject(sourcePath: string): string {
  if (!/\.mockupproject$/i.test(sourcePath)) {
    throw new MockupProjectConversionError(
      "invalid-source-path",
      translate("editor:mockupProject.errors.invalidSourcePath")
    );
  }
  return sourcePath.replace(/\.mockupproject$/i, ".canvas");
}

export function convertMockupProjectSource(source: string): string {
  const parsed = JSON.parse(source) as MockupProjectCanvasSource;
  const canvas = convertMockupProjectToCanvas(parsed);
  const canvasContent = serializeCanvasDocument(canvas);
  const verified = parseCanvasDocument(canvasContent);

  const sourceNodeCount = Array.isArray(parsed.mockups)
    ? parsed.mockups.length
    : 0;
  const sourceEdgeCount = Array.isArray(parsed.connections)
    ? parsed.connections.length
    : 0;
  if (
    (verified.nodes?.length ?? 0) !== sourceNodeCount ||
    (verified.edges?.length ?? 0) !== sourceEdgeCount
  ) {
    throw new MockupProjectConversionError(
      "suspect-conversion",
      translate("editor:mockupProject.errors.suspectConversion")
    );
  }

  return canvasContent;
}

/**
 * Convert one legacy project through the host's compare-and-swap filesystem.
 *
 * The source is read but never included in the write set. The target uses a
 * null expected hash, so the host refuses the write if a sibling canvas exists
 * or appears after the read. ProjectFileService rolls a failed write back and
 * only returns a receipt once its single-file write is complete.
 */
export async function convertMockupProjectFile(
  fs: EditorHostFileSystem,
  sourcePath: string
): Promise<MockupProjectConversionResult> {
  const targetPath = canvasPathForMockupProject(sourcePath);
  const [source, target] = await fs.read([sourcePath, targetPath]);

  if (!source?.exists || source.content === null) {
    throw new MockupProjectConversionError(
      "source-missing",
      translate("editor:mockupProject.errors.sourceMissing")
    );
  }
  if (target?.exists) {
    throw new MockupProjectConversionError(
      "target-exists",
      translate("editor:mockupProject.errors.targetExists", { path: targetPath })
    );
  }

  const canvasContent = convertMockupProjectSource(source.content);
  await fs.write({
    label: "Convert mockup project to canvas",
    actor: "user",
    changes: [
      {
        path: targetPath,
        expectedSha256: null,
        content: canvasContent,
      },
    ],
  });

  const [written] = await fs.read([targetPath]);
  if (!written?.exists || written.content !== canvasContent) {
    throw new MockupProjectConversionError(
      "verification-failed",
      translate("editor:mockupProject.errors.verificationFailed")
    );
  }

  return { sourcePath, targetPath, canvasContent };
}
