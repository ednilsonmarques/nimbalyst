/**
 * NIB.85 stage d0, advisor f1b35cda request: the REAL installed mermaid (no
 * mock) rendered through renderMermaid at securityLevel 'strict'. Hostile
 * labels, click directives and attempts to switch the security level from
 * inside the diagram must not leave anything executable in the SVG.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// jsdom never loads images, and mermaid waits for every <img> inside a label to
// fire load/error (or report `complete`) before it measures. Without this shim a
// label that keeps an <img> hangs the render queue, which says nothing about
// security. A real browser fires `error` for src=x and moves on.
beforeAll(() => {
  Object.defineProperty(HTMLImageElement.prototype, 'complete', { configurable: true, get: () => true });
});

let renderMermaid: typeof import('../mermaidRender').renderMermaid;
beforeEach(async () => {
  // A fresh mermaid instance per test, so one diagram cannot influence the next
  // (mermaid keeps config and a render queue as module state).
  vi.resetModules();
  ({ renderMermaid } = await import('../mermaidRender'));
});

let counter = 0;

async function render(source: string): Promise<{ svg: string; doc: Document }> {
  const id = `mermaid_real_sec_${counter++}`;
  const { svg } = await renderMermaid(id, source, false);
  const doc = new DOMParser().parseFromString(`<body>${svg}</body>`, 'text/html');
  return { svg, doc };
}

/** Everything that could run script or navigate, found anywhere in the output. */
function executableSurface(doc: Document, svg: string): string[] {
  const found: string[] = [];
  if (doc.querySelector('script')) found.push('script element');
  if (doc.querySelector('iframe, object, embed')) found.push('frame/object element');
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name)) found.push(`${el.tagName}[${attr.name}]`);
      if (/^(href|xlink:href|src|action|formaction)$/i.test(attr.name) && /^\s*(javascript|data|vbscript):/i.test(attr.value)) {
        found.push(`${el.tagName}[${attr.name}=${attr.value.slice(0, 30)}]`);
      }
    }
  }
  // SVG animation can rewrite an href to javascript: after load (<animate>/<set> values).
  for (const el of Array.from(doc.querySelectorAll('animate, set, animateTransform, animateMotion'))) {
    for (const name of ['to', 'from', 'by', 'values']) {
      const v = el.getAttribute(name) ?? '';
      if (/(^|;)\s*(javascript|data|vbscript):/i.test(v)) found.push(`${el.tagName}[${name}=${v.slice(0, 30)}]`);
    }
  }
  // CSS url() may only point inside the diagram (url(#id)); anything else can fetch or run.
  const outsideUrl = (css: string) => Array.from(css.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)).some((m) => !m[2].startsWith('#'));
  for (const el of Array.from(doc.querySelectorAll('[style]'))) {
    if (outsideUrl(el.getAttribute('style') ?? '')) found.push(`${el.tagName}[style url()]`);
  }
  for (const el of Array.from(doc.querySelectorAll('style'))) {
    if (outsideUrl(el.textContent ?? '')) found.push('<style> url()');
  }
  if (/javascript:/i.test(svg.replace(/&[a-z]+;|&#\d+;/gi, ''))) found.push('javascript: in markup');
  return found;
}

describe('executableSurface (the check these tests rely on)', () => {
  const parse = (svg: string) => new DOMParser().parseFromString(`<body>${svg}</body>`, 'text/html');
  it('flags SVG animation elements that set an href to javascript:', () => {
    const svg = '<svg><a><animate attributeName="href" values="javascript:alert(1)"/></a><a><set attributeName="href" to="javascript:alert(2)"/></a></svg>';
    expect(executableSurface(parse(svg), svg).length).toBeGreaterThanOrEqual(2);
  });
  it('flags style url() that points outside the diagram, in attributes and in <style>', () => {
    const attr = '<svg><rect style="fill:url(https://evil.example/x.svg#f)"/></svg>';
    expect(executableSurface(parse(attr), attr)).not.toEqual([]);
    const sheet = '<svg><style>.a{background:url(javascript:alert(1))}</style></svg>';
    expect(executableSurface(parse(sheet), sheet)).not.toEqual([]);
  });
  it('accepts the references a diagram legitimately has (url(#id) markers, plain animation)', () => {
    const svg = '<svg><marker id="m"/><path style="marker-end:url(#m)"/><style>.a{fill:url(#m)}</style><animate attributeName="opacity" values="0;1"/></svg>';
    expect(executableSurface(parse(svg), svg)).toEqual([]);
  });
});

describe('real mermaid under securityLevel strict (via renderMermaid)', { timeout: 30000 }, () => {
  it('renders an ordinary diagram (positive control)', async () => {
    const { svg, doc } = await render('flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]');
    expect(svg).toContain('<svg');
    expect(doc.body.textContent).toContain('Start');
    expect(doc.body.textContent).toContain('Done');
    expect(executableSurface(doc, svg)).toEqual([]);
  });

  it('leaves no script and no handler from <img onerror> / <script> labels', async () => {
    const { svg, doc } = await render('flowchart TD\n  A["<img src=x onerror=window.__nibMermaid=true>"] --> B["<script>window.__nibMermaid=true</script>"]');
    expect(executableSurface(doc, svg)).toEqual([]);
    expect((globalThis as any).__nibMermaid).toBeUndefined();
  });

  // CHARACTERIZATION (not a guarantee we want): strict keeps an inert <img> in an
  // HTML label, with onerror removed. A remote src would still be fetched when
  // the diagram is shown; see mermaid-real.md.
  it('keeps an <img> element from an HTML label but without any event handler', async () => {
    const { doc } = await render('flowchart TD\n  A["<img src=x onerror=window.__nibMermaid=true>"] --> B');
    const imgs = Array.from(doc.querySelectorAll('img'));
    for (const img of imgs) {
      expect(Array.from(img.attributes).map((a) => a.name).filter((n) => /^on/i.test(n))).toEqual([]);
    }
  });

  it('does not keep handlers from HTML markup in labels of other diagram types', async () => {
    const { svg, doc } = await render('sequenceDiagram\n  participant A as <img src=x onerror=alert(1)>\n  A->>A: <b onclick="alert(1)">hi</b>');
    expect(executableSurface(doc, svg)).toEqual([]);
  });

  it('gives a click callback directive no working binding (no handler, no link)', async () => {
    const { svg, doc } = await render('flowchart TD\n  A --> B\n  click A callAnything "tooltip"');
    expect(executableSurface(doc, svg)).toEqual([]);
    expect(doc.querySelector('a')).toBeNull();
    // the node may carry a cosmetic "clickable" class; it has no handler attribute.
    for (const el of Array.from(doc.querySelectorAll('.clickable'))) {
      expect(Array.from(el.attributes).filter((a) => /^on/i.test(a.name))).toEqual([]);
    }
  });

  it('gives a click href javascript: directive no href', async () => {
    const { svg, doc } = await render('flowchart TD\n  A --> B\n  click A href "javascript:window.__nibMermaid=true" "tip"');
    expect(executableSurface(doc, svg)).toEqual([]);
    for (const a of Array.from(doc.querySelectorAll('a'))) {
      expect(a.getAttribute('href') ?? a.getAttribute('xlink:href') ?? '').not.toMatch(/javascript:/i);
    }
    expect((globalThis as any).__nibMermaid).toBeUndefined();
  });

  // CHARACTERIZATION: strict still turns an https click href into a real link.
  it('keeps an https click href as a plain link (so navigation policy matters)', async () => {
    const { doc } = await render('flowchart TD\n  A --> B\n  click A href "https://example.com" "tip"');
    expect(doc.querySelector('a')?.getAttribute('href')).toBe('https://example.com/');
  });

  it('ignores an init directive that tries to set securityLevel loose', async () => {
    const { svg, doc } = await render('%%{init: {"securityLevel":"loose"}}%%\nflowchart TD\n  A["<img src=x onerror=window.__nibMermaid=true>"] --> B\n  click A href "javascript:window.__nibMermaid=true"');
    expect(executableSurface(doc, svg)).toEqual([]);
    for (const a of Array.from(doc.querySelectorAll('a'))) expect(a.hasAttribute('href')).toBe(false);
  });

  it('ignores frontmatter config that tries to set securityLevel loose', async () => {
    const { svg, doc } = await render('---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\n  A["<img src=x onerror=window.__nibMermaid=true>"] --> B\n  click A href "javascript:window.__nibMermaid=true"');
    expect(executableSurface(doc, svg)).toEqual([]);
    for (const a of Array.from(doc.querySelectorAll('a'))) expect(a.hasAttribute('href')).toBe(false);
  });

  it('ignores an init directive that tries to relax sanitizing', async () => {
    const { svg, doc } = await render('%%{init: {"flowchart":{"htmlLabels":true},"dompurifyConfig":{"ALLOW_UNKNOWN_PROTOCOLS":true,"ADD_ATTR":["onerror"]},"secure":[]}}%%\nflowchart TD\n  A["<img src=x onerror=window.__nibMermaid=true>"] --> B');
    expect(executableSurface(doc, svg)).toEqual([]);
  });
});
