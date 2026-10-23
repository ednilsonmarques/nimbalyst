/**
 * Schemas of the `portal_*` tools. A leaf module (no electron imports) so the
 * tool-budget and topology tests can load the real catalog in a plain node
 * environment; the handlers live in portalToolHandlers.ts.
 */

import { PORTAL_TOOLS } from '@nimbalyst/runtime/ai/server/providers/claudeCode/toolPolicy';

export const PORTAL_TOOL_NAMES: readonly string[] = PORTAL_TOOLS;

export function isPortalToolName(name: string): boolean {
  return PORTAL_TOOL_NAMES.includes(name);
}

const SESSION_ID = {
  sessionId: { type: 'string', description: 'Portal id returned by portal_open (see portal_list for the portals you own).' },
};
const TARGET = {
  selector: { type: 'string', description: 'CSS selector of the target element.' },
  index: { type: 'number', description: 'Index of an element from a prior portal_page_info `interactive` list.' },
};
const PORT_LIMIT =
  'Declared ports limit interaction through the page UI, not the network: where evaluate is allowed, page script can still fetch any loopback port.';
const CONFINEMENT =
  'A portal is bound to the origin it opened on: top-level navigation, redirects and frames cannot leave it. Subresources and fetches the page makes are NOT restricted.';
const MARK =
  'Needs the project to be marked as test data AND, on a localhost page, a declared port (the user turns both on in Settings > Agent Permissions; agents cannot). Without them the portal is observe-only. Pages of the project\'s own files need only the mark.';

export const portalToolSchemas: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
  {
    name: 'portal_open',
    description: `Open the project's local preview in a headless portal you own (at most 2 at a time). Give filePath (an HTML file in the workspace, served over nim-preview) or url (a loopback dev server: http://localhost, 127.0.0.1 or [::1]). Any other URL is refused. Agents can observe any local service on any port; clicking, typing and evaluating need the project to be marked as test data and, on localhost, a declared port. ${CONFINEMENT} Returns the portal sessionId.`,
    inputSchema: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Absolute path to an .html/.htm file in the workspace.' },
        url: { type: 'string', description: 'http://localhost[:port]/..., http://127.0.0.1[:port]/... or http://[::1][:port]/...' },
        width: { type: 'number', description: 'Viewport width in CSS px.' },
        height: { type: 'number', description: 'Viewport height in CSS px.' },
      },
    },
  },
  {
    name: 'portal_navigate',
    description: `Navigate a portal to another page on its own origin (an absolute URL, or a path relative to the current page). ${CONFINEMENT}`,
    inputSchema: {
      type: 'object',
      properties: { ...SESSION_ID, url: { type: 'string', description: 'URL on the portal origin, or a relative path.' } },
      required: ['sessionId', 'url'],
    },
  },
  {
    name: 'portal_list',
    description: 'List the ids of the portals you opened. Portals of other agents and the user\'s own browser tabs are never listed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'portal_close',
    description: 'Close a portal you opened and wipe its storage.',
    inputSchema: { type: 'object', properties: { ...SESSION_ID }, required: ['sessionId'] },
  },
  {
    name: 'portal_screenshot',
    description: 'Capture a screenshot of a portal and save it as a PNG under the workspace. Returns the file path.',
    inputSchema: {
      type: 'object',
      properties: { ...SESSION_ID, label: { type: 'string', description: 'Optional label used in the filename.' } },
      required: ['sessionId'],
    },
  },
  {
    name: 'portal_page_info',
    description: 'Read the current page of a portal: url, title, visible text (truncated) and an indexed list of interactive elements to use with portal_click / portal_type. Form-field contents are never returned.',
    inputSchema: { type: 'object', properties: { ...SESSION_ID }, required: ['sessionId'] },
  },
  {
    name: 'portal_scroll',
    description: 'Scroll the portal page by a delta (dx/dy) or scroll a selector/index element into view.',
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID, ...TARGET,
        dx: { type: 'number', description: 'Horizontal scroll delta in px.' },
        dy: { type: 'number', description: 'Vertical scroll delta in px.' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'portal_click',
    description: `Click in a portal with a real input event: by selector, by an index from portal_page_info, or by x/y CSS-pixel coordinates. ${MARK} ${PORT_LIMIT}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID, ...TARGET,
        x: { type: 'number', description: 'X in CSS px (alternative to selector/index).' },
        y: { type: 'number', description: 'Y in CSS px (alternative to selector/index).' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'portal_type',
    description: `Type text into a portal element (real character events). Target by selector or index; omit both to type into the focused element. clear=true empties the field first. ${MARK}`,
    inputSchema: {
      type: 'object',
      properties: {
        ...SESSION_ID, ...TARGET,
        text: { type: 'string', description: 'Text to type.' },
        clear: { type: 'boolean', description: 'Clear the field before typing.' },
      },
      required: ['sessionId', 'text'],
    },
  },
  {
    name: 'portal_evaluate',
    description: `Run JavaScript in the portal page and return its serializable result. Only sessions with full scope get this tool (not reviewers or implementers). ${MARK} ${PORT_LIMIT}`,
    inputSchema: {
      type: 'object',
      properties: { ...SESSION_ID, script: { type: 'string', description: 'JavaScript expression to evaluate in the page.' } },
      required: ['sessionId', 'script'],
    },
  },
];
