import * as React from 'react';
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { $getRoot, $createParagraphNode, createEditor } from 'lexical';

import { $createTrackerReferenceNode, TrackerReferenceNode, TrackerReferenceNodeDecorator } from '../TrackerReferenceNode';
import { TrackerReferenceExternalChip } from '../TrackerReferenceExternalChip';
import { setTrackerReferenceNodeRenderer } from '../TrackerReferenceNodeRenderer';
import { setTrackerReferenceHomeScope } from '../trackerReferenceHref';

// HTML audit, item 5c: a data-driven href (it comes from a stored/pasted reference) must never end up as a
// navigable javascript:/data:/vbscript: link in the tracker reference components.
const HOSTILE = [
  'javascript:alert(1)',
  ' JaVaScRiPt:alert(1)',
  'java\tscript:alert(1)',
  'java\nscript:alert(1)',
  '\u0000javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///C:/Windows/system32',
];

/** An anchor can navigate only through an href with one of these schemes; browsers drop tabs/newlines/control characters inside a scheme. */
function navigableScheme(href: string | null): string | null {
  if (href === null) return null;
  const m = href.replace(/[\u0000-\u0020]/g, '').match(/^([a-z][a-z0-9+.-]*):/i);
  return m ? m[1].toLowerCase() : null;
}

function allHrefs(container: HTMLElement): string[] {
  return [...container.querySelectorAll('[href]')].map((e) => e.getAttribute('href') ?? '');
}

afterEach(() => {
  setTrackerReferenceNodeRenderer(undefined);
  setTrackerReferenceHomeScope(undefined);
});

describe('the external tracker reference chip', () => {
  it('never emits a javascript:, data:, vbscript: or file: href, even if it is handed one', () => {
    for (const href of HOSTILE) {
      const { container, unmount } = render(<TrackerReferenceExternalChip referenceKey="NIM-1" href={href} />);
      const a = container.querySelector('a')!;
      expect(a, JSON.stringify(href)).toBeTruthy();
      expect(['http', 'https', null], JSON.stringify(href)).toContain(navigableScheme(a.getAttribute('href')));
      expect(a.getAttribute('href') ?? '').not.toMatch(/javascript|vbscript|data:/i);
      unmount();
    }
  });

  it('keeps a real https console link navigable', () => {
    const href = 'https://console.nimbalyst.com/org/org-1/project/elsewhere/trackers/item/NIM-1';
    const { container } = render(<TrackerReferenceExternalChip referenceKey="NIM-1" href={href} />);
    expect(container.querySelector('a')!.getAttribute('href')).toBe(href);
  });
});

describe('a tracker reference node whose stored href is hostile', () => {
  function renderNode(href: string): HTMLElement {
    const editor = createEditor({ nodes: [TrackerReferenceNode], onError: (error) => { throw error; } });
    let element: React.ReactNode = null;
    editor.update(() => {
      const node = $createTrackerReferenceNode('NIM-1', 'chip', null, href);
      $getRoot().append($createParagraphNode().append(node));
      element = TrackerReferenceNodeDecorator.decorate(node, editor, { namespace: 'test', theme: {} });
    }, { discrete: true });
    return render(<>{element}</>).container;
  }

  it('is rendered without any javascript:/data:/vbscript: link, with or without a host renderer', () => {
    for (const withRenderer of [false, true]) {
      setTrackerReferenceNodeRenderer(withRenderer ? ({ referenceKey }) => <span data-testid="local-chip">{referenceKey}</span> : undefined);
      setTrackerReferenceHomeScope({ orgId: 'org-1', projectId: 'home' });
      for (const href of HOSTILE) {
        const container = renderNode(href);
        for (const found of allHrefs(container)) {
          expect(['http', 'https', null], `${withRenderer} ${JSON.stringify(href)} -> ${found}`).toContain(navigableScheme(found));
        }
        expect(container.querySelector('[data-testid="tracker-reference-external"]'), JSON.stringify(href)).toBeNull();
      }
    }
  });
});
