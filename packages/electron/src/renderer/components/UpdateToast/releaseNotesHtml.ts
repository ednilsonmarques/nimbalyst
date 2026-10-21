import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Configure marked for rendering release notes
marked.setOptions({
  breaks: true,
  gfm: true,
});

// Release notes are prose: formatting only. DOMPurify's default profile still
// allows form controls and inline styles, which a notes page has no use for and
// which could be used to dress up a fake prompt inside the dialog.
// Links: only http(s) and mailto keep an href (protocol-relative `//host` and
// relative paths would resolve against the app's own origin and lose it).
// `class` is dropped so notes cannot borrow the app's utility classes
// (e.g. `fixed inset-0 z-[99999]`) to overlay the dialog.
const SANITIZE_OPTIONS = {
  FORBID_TAGS: ['form', 'input', 'textarea', 'select', 'button', 'style'],
  FORBID_ATTR: ['style', 'class'],
  ALLOWED_URI_REGEXP: /^(?:https?|mailto):/i,
};

/**
 * Render release-notes markdown to HTML that is safe for dangerouslySetInnerHTML.
 *
 * The notes come from outside the app (update feed / release page) and marked
 * passes raw HTML through, so the output is sanitized with DOMPurify's default
 * profile: headings, lists, code, emphasis and links survive; scripts, event
 * handler attributes, javascript: URLs, iframes, objects and forms do not.
 *
 * `emptyHtml` is trusted, caller-supplied markup shown when there are no notes.
 */
export function renderReleaseNotesHtml(releaseNotes: string, emptyHtml: string): string {
  if (!releaseNotes) {
    return emptyHtml;
  }
  let html: string;
  try {
    html = marked.parse(releaseNotes) as string;
  } catch (err) {
    console.error('[ReleaseNotesDialog] Failed to parse release notes:', err);
    // Fall back to the notes as plain text, never as markup.
    const escaped = releaseNotes
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    html = `<p>${escaped}</p>`;
  }
  return DOMPurify.sanitize(html, SANITIZE_OPTIONS);
}
