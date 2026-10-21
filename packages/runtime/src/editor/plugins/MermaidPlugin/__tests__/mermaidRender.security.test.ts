/**
 * NIB.85 stage d0 / decision U7: mermaid runs at securityLevel 'strict', so
 * HTML in labels is encoded and click directives do not become links.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const initialize = vi.fn();

vi.mock('mermaid', () => ({
  default: { initialize: (...args: unknown[]) => initialize(...args), render: vi.fn() },
}));

describe('loadMermaid security configuration', () => {
  beforeEach(() => {
    initialize.mockReset();
    vi.resetModules();
  });

  it("initializes mermaid with securityLevel 'strict' (light theme)", async () => {
    const { loadMermaid } = await import('../mermaidRender');
    await loadMermaid(false);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(initialize.mock.calls[0][0].securityLevel).toBe('strict');
  });

  it("keeps securityLevel 'strict' when the theme changes and mermaid is re-initialized", async () => {
    const { loadMermaid } = await import('../mermaidRender');
    await loadMermaid(false);
    await loadMermaid(true);
    expect(initialize).toHaveBeenCalledTimes(2);
    for (const call of initialize.mock.calls) {
      expect(call[0].securityLevel).toBe('strict');
    }
  });
});
