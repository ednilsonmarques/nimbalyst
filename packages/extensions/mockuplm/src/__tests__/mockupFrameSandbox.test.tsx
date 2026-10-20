import React from "react";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@nimbalyst/extension-sdk", async () => {
  const actual = await vi.importActual<
    typeof import("@nimbalyst/extension-sdk")
  >("@nimbalyst/extension-sdk");
  return {
    ...actual,
    useEditorLifecycle: (
      host: { testContent?: string },
      options: { applyContent(content: string): void }
    ) => {
      React.useEffect(() => {
        if (host.testContent) options.applyContent(host.testContent);
      }, [host]);
      return {
        markDirty: vi.fn(),
        isLoading: false,
        error: null,
        theme: "dark",
        diffState: null,
      };
    },
    useCollaborativeEditor: vi.fn(),
  };
});

import { MockupEditor } from "../components/MockupEditor";
import { MockupDiffViewer } from "../components/MockupDiffViewer";

function stubHost(extra: Record<string, unknown> = {}) {
  return {
    filePath: "/workspace/dashboard.mockup.html",
    fileName: "dashboard.mockup.html",
    isActive: false,
    readOnly: false,
    registerEditorAPI: vi.fn(),
    onReadOnlyChanged: vi.fn(() => () => undefined),
    onThemeChanged: vi.fn(() => () => undefined),
    onSaveRequested: vi.fn(() => () => undefined),
    onDiffRequested: vi.fn(() => () => undefined),
    onContentChanged: vi.fn(() => () => undefined),
    loadContent: vi.fn(async () => "<html><body>Dashboard</body></html>"),
    saveContent: vi.fn(async () => undefined),
    setDirty: vi.fn(),
    reportDiffResult: vi.fn(),
    ...extra,
  } as never;
}

function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
  } as never);
}

/**
 * A mockup is untrusted markup rendered into a frame that shares the renderer's
 * origin (`allow-same-origin`). If that frame may also run scripts, the mockup
 * reaches `parent.electronAPI` (proved at runtime in NIB.85 stage a). The token
 * list must therefore be exactly `allow-same-origin`, in every place a mockup
 * document is rendered.
 */
function expectNoScriptSandbox(frames: NodeListOf<HTMLIFrameElement>, count: number) {
  expect(frames).toHaveLength(count);
  for (const frame of Array.from(frames)) {
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin");
    // jsdom has no HTMLIFrameElement.sandbox token list.
    expect(frame.getAttribute("sandbox")!.split(/\s+/)).not.toContain("allow-scripts");
  }
}

describe("MockupLM frames never allow scripts", () => {
  it("editor frame", () => {
    stubCanvas();
    const { container } = render(<MockupEditor host={stubHost()} />);
    expectNoScriptSandbox(container.querySelectorAll("iframe"), 1);
  });

  it("read-only viewer frame", () => {
    stubCanvas();
    const { container } = render(
      <MockupEditor host={stubHost({ readOnly: true, embedded: true })} />
    );
    expectNoScriptSandbox(container.querySelectorAll("iframe"), 1);
  });

  it("diff viewer, new file (one frame)", () => {
    const { container } = render(
      <MockupDiffViewer originalHtml="" updatedHtml="<p>new</p>" fileName="a.mockup.html" />
    );
    expectNoScriptSandbox(container.querySelectorAll("iframe"), 1);
  });

  it("diff viewer, modified file (before and after frames)", () => {
    const { container } = render(
      <MockupDiffViewer
        originalHtml="<p>old</p>"
        updatedHtml="<p>new</p>"
        fileName="a.mockup.html"
      />
    );
    expectNoScriptSandbox(container.querySelectorAll("iframe"), 2);
  });
});
