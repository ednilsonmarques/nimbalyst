/**
 * NIB.85 stage d0: release notes are markdown fetched from outside the app and
 * rendered with dangerouslySetInnerHTML, so the HTML must be sanitized while
 * the dialog's formatting (headings, lists, code, links) survives.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { marked } from 'marked';
import { renderReleaseNotesHtml } from '../releaseNotesHtml';

function render(markdown: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderReleaseNotesHtml(markdown, '<p>none</p>');
  return host;
}

describe('renderReleaseNotesHtml', () => {
  it('strips script elements', () => {
    const host = render('# Notes\n\n<script>window.__nibD0 = true</script>\n\nafter');
    expect(host.querySelector('script')).toBeNull();
    expect(host.innerHTML).not.toContain('__nibD0');
    expect(host.textContent).toContain('after');
  });

  it('strips event-handler attributes but keeps the element text', () => {
    const host = render('hello <img src=x onerror="window.__nibD0=true"> <b onclick="x()">bold</b>');
    expect(host.querySelectorAll('[onerror], [onclick]').length).toBe(0);
    expect(host.querySelector('b')?.textContent).toBe('bold');
  });

  it('neutralizes javascript: links from markdown and raw HTML', () => {
    const host = render('[click](javascript:alert(1)) <a href="javascript:alert(2)">raw</a>');
    for (const a of Array.from(host.querySelectorAll('a'))) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
    }
  });

  it('removes iframes, objects and forms', () => {
    const host = render('<iframe src="https://example.com"></iframe><object data="x"></object><form action="x"><input></form>ok');
    expect(host.querySelectorAll('iframe, object, embed, form, input').length).toBe(0);
    expect(host.textContent).toContain('ok');
  });

  it('keeps the dialog formatting: headings, lists, code, links, emphasis', () => {
    const host = render([
      '## Added',
      '',
      '- one **bold**',
      '- two `code`',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '[docs](https://example.com/docs)',
    ].join('\n'));
    expect(host.querySelector('h2')?.textContent).toBe('Added');
    expect(host.querySelectorAll('ul > li').length).toBe(2);
    expect(host.querySelector('strong')?.textContent).toBe('bold');
    expect(host.querySelector('li code')?.textContent).toBe('code');
    expect(host.querySelector('pre code')?.textContent).toContain('const x = 1;');
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://example.com/docs');
  });

  it('keeps only http(s) and mailto links: protocol-relative and relative hrefs lose their href', () => {
    const host = render([
      '[x](//evil.example/a) [y](./rel) <a href="//evil.example">raw</a>',
      '',
      '[docs](https://example.com/docs) [plain](http://example.com/p) [mail](mailto:team@example.com)',
    ].join('\n'));
    const byText = (t: string) => Array.from(host.querySelectorAll('a')).find((a) => a.textContent === t)!;
    expect(byText('x').hasAttribute('href')).toBe(false);
    expect(byText('y').hasAttribute('href')).toBe(false);
    expect(byText('raw').hasAttribute('href')).toBe(false);
    expect(byText('docs').getAttribute('href')).toBe('https://example.com/docs');
    expect(byText('plain').getAttribute('href')).toBe('http://example.com/p');
    expect(byText('mail').getAttribute('href')).toBe('mailto:team@example.com');
  });

  it('drops class attributes so notes cannot pick up the utility classes of the app', () => {
    const host = render('<div class="fixed inset-0 z-[99999] bg-white">x</div>');
    expect(host.textContent).toContain('x');
    expect(host.querySelectorAll('[class]').length).toBe(0);
  });

  describe('when markdown parsing throws', () => {
    afterEach(() => { vi.restoreAllMocks(); });

    it('falls back to escaped text, never markup', () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(marked, 'parse').mockImplementation(() => { throw new Error('boom'); });
      const html = renderReleaseNotesHtml('<script>x</script>', '<p>none</p>');
      expect(html).toContain('&lt;script&gt;');
      expect(html).not.toContain('<script>');
      const host = document.createElement('div');
      host.innerHTML = html;
      expect(host.querySelector('script')).toBeNull();
      expect(host.textContent).toContain('<script>x</script>');
    });
  });

  it('returns the supplied empty-state markup when there are no notes', () => {
    expect(renderReleaseNotesHtml('', '<p>none</p>')).toBe('<p>none</p>');
  });
});
