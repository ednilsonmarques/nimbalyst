/**
 * Agent tools for the one page tree (Pages mode), for the Team and the
 * Personal section alike: list the tree, create a page under a page or a typed
 * page, move or reorder pages, typed pages and placed types, rename, delete,
 * and Set type.
 *
 * Every structural write goes through the same planner the sidebar's drag and
 * drop uses (`collabPageTree`), so an agent gets the same cycle refusals
 * (including the way up through a type node), the same one sibling order and
 * the same re-spacing of a group nobody reordered yet. The environment is
 * injected so the decisions are tested against a fake docs session; the
 * desktop wiring is electron's `desktopPageTreeEnv.ts`, and the collab
 * worker's remote Pages tools bring their own.
 *
 * Worker-safe: no React, no Jotai, and nothing from `session.ts`, even as a
 * type (`pageTreeSession.ts` is the part of a session this uses); the
 * session's Jotai-held type placements are read through the env.
 */
import {
  buildConsoleLink,
  type ConsoleLinkScope,
  type ListPagesResult,
  type PageTreeNodeSummary,
} from '@nimbalyst/collab-protocol';
import { isProtectedTrackerType } from '@nimbalyst/tracker-core';
import {
  isTypePageDocumentId,
  pageDisplayName,
  type CollabTreeNode,
  type CollabTypeTreeResolver,
} from './collabTree';
import type { PageTreeDragged, PageTreeWrite } from './collabPageTree';
import type { PageTreeSession, PageTreeWriteResult } from './pageTreeSession';
import type { SharedDocument, SharedParentKind, SharedTypePlacement } from './types';

/** The tree builder and move planner, loaded on demand as the docs barrel does. */
const loadCollabPageTree = () => import('./collabPageTree');

export type PageTreeSection = 'team' | 'personal';

export type PageTreeToolResult =
  | { success: true; [key: string]: unknown }
  | { success: false; error: string };

export interface PageTreeItemRef {
  itemId: string;
  typeId: string;
  issueKey?: string;
}

export interface SetPageTypeToolOutcome {
  status: 'done' | 'refused' | 'failed';
  message?: string;
  itemId?: string;
}

export interface PageTreeToolEnv {
  /** The section's docs session. Team throws when the window has no team scope. */
  session(section: PageTreeSection): Promise<PageTreeSession>;
  /** Types and typed pages of the section's own lane. */
  resolver(section: PageTreeSection): CollabTypeTreeResolver;
  /** The session's current type placements. */
  typePlacements(session: PageTreeSession): SharedTypePlacement[];
  /** A tracker item by id or issue key; null when this window does not hold it. */
  findItem(ref: string): PageTreeItemRef | null;
  /** Create a page the way a person does; resolves its document id. */
  createPage(section: PageTreeSection, session: PageTreeSession, input: {
    title: string;
    documentType: string;
    parentId: string | null;
    parentKind: SharedParentKind;
    content: string;
  }): Promise<string>;
  /** Run Set type on a plain page. */
  setPageType(section: PageTreeSection, session: PageTreeSession, page: SharedDocument, typeId: string): Promise<SetPageTypeToolOutcome>;
  /** The uri an agent reads and edits the page body at. */
  pageUri(section: PageTreeSection, documentId: string): string | null;
}

type PageTreeModule = Awaited<ReturnType<typeof loadCollabPageTree>>;

interface TreeContext {
  section: PageTreeSection;
  session: PageTreeSession;
  resolver: CollabTypeTreeResolver;
  planner: PageTreeModule;
  tree: CollabTreeNode[];
  nodes: Map<string, CollabTreeNode>;
  parents: Map<string, CollabTreeNode | null>;
}

const fail = (error: string): PageTreeToolResult => ({ success: false, error });

const sectionOf = (value: unknown): PageTreeSection => (value === 'personal' ? 'personal' : 'team');

const childrenOf = (node: CollabTreeNode): CollabTreeNode[] =>
  node.type === 'type' || node.type === 'folder' ? node.children : node.children ?? [];

async function readTree(env: PageTreeToolEnv, section: PageTreeSection): Promise<TreeContext> {
  const session = await env.session(section);
  await session.start();
  if (!session.isPageTree()) {
    throw new Error('This section still uses folders; the page tree tools need a server with the page tree.');
  }
  const resolver = env.resolver(section);
  const planner = await loadCollabPageTree();
  const tree = planner.buildCollabPageTree(session.getDocuments(), {
    resolver,
    typePlacements: env.typePlacements(session),
    itemPlacements: session.getItemPlacements(),
    currentProjectId: session.scope.indexConfig?.teamProjectId ?? null,
  });
  const nodes = new Map<string, CollabTreeNode>();
  const parents = new Map<string, CollabTreeNode | null>();
  const index = (list: CollabTreeNode[], parent: CollabTreeNode | null) => {
    for (const node of list) {
      nodes.set(node.id, node);
      parents.set(node.id, parent);
      index(childrenOf(node), node);
    }
  };
  index(tree, null);
  return { section, session, resolver, planner, tree, nodes, parents };
}

function findPage(context: TreeContext, documentId: string): SharedDocument | undefined {
  return context.session.getDocuments().find((document) => document.documentId === documentId);
}

/**
 * A parent named by id: a page, or a typed page by item id or issue key. The
 * kind is taken from what the id names unless the caller said; an explicit
 * kind that does not match is refused rather than guessed.
 */
function resolveParent(
  env: PageTreeToolEnv,
  context: TreeContext,
  ref: unknown,
  kind: unknown,
): { parentId: string | null; parentKind: SharedParentKind } | { error: string } {
  if (ref === null || ref === undefined || ref === '') return { parentId: null, parentKind: 'page' };
  if (typeof ref !== 'string') return { error: 'The parent must be a page id, a typed page id or issue key, or null.' };
  if (kind !== 'item' && findPage(context, ref) && !isTypePageDocumentId(ref)) return { parentId: ref, parentKind: 'page' };
  if (kind !== 'page') {
    const item = env.findItem(ref);
    if (item && context.resolver.item?.(item.itemId)) return { parentId: item.itemId, parentKind: 'item' };
  }
  return { error: `No page or typed page "${ref}" in the ${context.section} section.` };
}

/** A node named in `before`/`after`: a tree node id, or a bare page id, item id, issue key or type id. */
function resolveNodeRef(env: PageTreeToolEnv, context: TreeContext, ref: string): string | null {
  if (context.nodes.has(ref)) return ref;
  if (context.nodes.has(`document:${ref}`)) return `document:${ref}`;
  const item = env.findItem(ref);
  if (item && context.nodes.has(`item:${item.itemId}`)) return `item:${item.itemId}`;
  if (context.nodes.has(`type:${ref}`)) return `type:${ref}`;
  return null;
}

/** Walk "A/B" by title from the root, creating missing pages (empty bodies). */
async function resolvePagePath(
  env: PageTreeToolEnv,
  context: TreeContext,
  folderPath: string,
): Promise<{ parentId: string | null; parentKind: SharedParentKind }> {
  let parent: { parentId: string | null; parentKind: SharedParentKind } = { parentId: null, parentKind: 'page' };
  let siblings = context.tree;
  for (const segment of folderPath.split('/').map((part) => part.trim()).filter(Boolean)) {
    const match = siblings.find((node) =>
      (node.type === 'document' && pageDisplayName(node.document.title, node.document.documentType) === segment)
      || (node.type === 'item' && node.name === segment));
    if (match?.type === 'document') {
      parent = { parentId: match.document.documentId, parentKind: 'page' };
      siblings = childrenOf(match);
    } else if (match?.type === 'item') {
      parent = { parentId: match.itemId, parentKind: 'item' };
      siblings = childrenOf(match);
    } else {
      const documentId = await env.createPage(context.section, context.session, {
        title: segment, documentType: 'markdown', ...parent, content: '',
      });
      parent = { parentId: documentId, parentKind: 'page' };
      siblings = [];
    }
  }
  return parent;
}

const INSIDE_ITSELF = 'Refused: that would put it inside itself (also counting the way up through a type).';

/** The store's answer to a write: success, or the refusal it gave. */
async function settled(write: Promise<PageTreeWriteResult>, what: string): Promise<PageTreeToolResult> {
  const result = await write;
  return result.ok ? { success: true } : fail(`The ${what} was refused: ${result.error}`);
}

/** Apply one planned write and wait for the store's answer. */
async function applyWrite(session: PageTreeSession, write: PageTreeWrite): Promise<string | null> {
  if (write.kind === 'page') {
    const moved = session.movePage(write.documentId, write.parentId, { parentKind: write.parentKind, sortOrder: write.sortOrder });
    if (!moved) return INSIDE_ITSELF;
    const result = await settled(moved, 'move');
    return result.success ? null : result.error;
  }
  const result = write.kind === 'type'
    ? await settled(session.moveTypePlacement(write.typeId, write.parentFolderId, write.sortOrder, write.parentKind), 'placement')
    : await settled(session.setItemPlacement(write.itemId, write.parentId, write.sortOrder, write.parentKind), 'placement');
  return result.success ? null : result.error;
}

/**
 * Where the section's console links point: the team project, or `local` for
 * Personal pages. Null for a team scope that has no team project id yet, so
 * an agent is told rather than handed a link that guesses.
 */
function consoleScopeOf(context: TreeContext): ConsoleLinkScope | null {
  if (context.section === 'personal') return 'local';
  const projectId = context.session.scope.indexConfig?.teamProjectId;
  return projectId ? { orgId: context.session.scope.orgId, projectId } : null;
}

function describeNode(context: TreeContext, env: PageTreeToolEnv, node: CollabTreeNode, depth: number): PageTreeNodeSummary | null {
  const parentNodeId = context.parents.get(node.id)?.id ?? null;
  const scope = consoleScopeOf(context);
  if (node.type === 'document') {
    return {
      nodeId: node.id,
      kind: 'page',
      id: node.document.documentId,
      title: pageDisplayName(node.document.title, node.document.documentType),
      parentNodeId,
      depth,
      sortOrder: node.document.sortOrder ?? null,
      uri: env.pageUri(context.section, node.document.documentId),
      ...(scope ? { link: buildConsoleLink({ kind: 'page', scope, pageId: node.document.documentId }) } : {}),
    };
  }
  if (node.type === 'item') {
    const item = env.findItem(node.itemId);
    return {
      nodeId: node.id,
      kind: 'typedPage',
      id: node.itemId,
      ...(item?.issueKey ? { issueKey: item.issueKey } : {}),
      typeId: node.typeId,
      title: node.name,
      parentNodeId,
      depth,
      placed: node.placed === true,
      sortOrder: node.placed ? node.sortOrder ?? null : null,
      ...(scope ? { link: buildConsoleLink({ kind: 'item', scope, itemRef: item?.issueKey ?? node.itemId }) } : {}),
    };
  }
  if (node.type === 'type') {
    return {
      nodeId: node.id,
      kind: 'type',
      id: node.typeId,
      title: node.name,
      parentNodeId,
      depth,
      sortOrder: node.placement.sortOrder,
      ...(scope ? {
        link: buildConsoleLink({ kind: 'type', scope, typeId: node.typeId }),
        viewLink: buildConsoleLink({ kind: 'view', scope, view: { kind: 'type', typeId: node.typeId } }),
      } : {}),
    };
  }
  return null;
}

export async function listPagesTool(env: PageTreeToolEnv, args: Record<string, unknown>): Promise<PageTreeToolResult> {
  const context = await readTree(env, sectionOf(args.section));
  const nodes: PageTreeNodeSummary[] = [];
  const walk = (list: CollabTreeNode[], depth: number) => {
    for (const node of list) {
      const described = describeNode(context, env, node, depth);
      if (described) nodes.push(described);
      walk(childrenOf(node), depth + 1);
    }
  };
  walk(context.tree, 0);
  const scope = consoleScopeOf(context);
  const result: ListPagesResult = {
    section: context.section,
    consoleScope: scope,
    ...(scope ? { openMarksViewLink: buildConsoleLink({ kind: 'view', scope, view: { kind: 'marks', marks: 'open' } }) } : {}),
    nodes,
  };
  return { success: true, ...result };
}

export async function createPageTool(env: PageTreeToolEnv, args: Record<string, unknown>): Promise<PageTreeToolResult> {
  const title = typeof args.title === 'string' ? args.title.trim() : typeof args.name === 'string' ? args.name.trim() : '';
  if (!title) return fail('A page needs a title.');
  const context = await readTree(env, sectionOf(args.section));
  const parent = typeof args.folderPath === 'string'
    ? await resolvePagePath(env, context, args.folderPath)
    : resolveParent(env, context, args.parentFolderId, args.parentKind);
  if ('error' in parent) return fail(parent.error);

  const documentId = await env.createPage(context.section, context.session, {
    title,
    documentType: typeof args.documentType === 'string' && args.documentType ? args.documentType : 'markdown',
    ...parent,
    content: typeof args.initialContent === 'string' ? args.initialContent : '',
  });
  const scope = consoleScopeOf(context);
  const created = {
    success: true as const,
    documentId,
    uri: env.pageUri(context.section, documentId),
    ...(scope ? { link: buildConsoleLink({ kind: 'page', scope, pageId: documentId }) } : {}),
  };
  if (args.before === undefined && args.after === undefined && args.sortOrder === undefined) return created;

  const placed = await movePageTreeNodeTool(env, {
    section: context.section,
    kind: 'page',
    itemId: documentId,
    ...(args.before !== undefined || args.after !== undefined
      ? { before: args.before, after: args.after }
      : { newParentFolderId: parent.parentId, parentKind: parent.parentKind, sortOrder: args.sortOrder }),
  });
  return placed.success ? created : { ...created, warning: `Created, but not ordered: ${placed.error}` };
}

type MovingNode = { dragged: PageTreeDragged; nodeId: string };

function resolveMoving(env: PageTreeToolEnv, context: TreeContext, kind: unknown, id: string): MovingNode | { error: string } {
  if (kind === 'item') {
    const item = env.findItem(id);
    if (!item || !context.resolver.item?.(item.itemId)) return { error: `No typed page "${id}" in the ${context.section} section.` };
    return { dragged: { kind: 'item', itemId: item.itemId, typeId: item.typeId }, nodeId: `item:${item.itemId}` };
  }
  if (kind === 'type') {
    if (!context.resolver.typeName(id)) return { error: `"${id}" is not a ${context.section} type.` };
    return { dragged: { kind: 'type', typeId: id }, nodeId: `type:${id}` };
  }
  const page = findPage(context, id);
  if (!page || isTypePageDocumentId(id)) return { error: `No page "${id}" in the ${context.section} section.` };
  return { dragged: { kind: 'page', documentId: id }, nodeId: `document:${id}` };
}

export async function movePageTreeNodeTool(env: PageTreeToolEnv, args: Record<string, unknown>): Promise<PageTreeToolResult> {
  const id = typeof args.itemId === 'string' ? args.itemId : '';
  if (!id) return fail('Name what to move with itemId.');
  const context = await readTree(env, sectionOf(args.section));
  const { session, planner, tree } = context;
  const moving = resolveMoving(env, context, args.kind, id);
  if ('error' in moving) return fail(moving.error);
  const { dragged } = moving;

  // Beside a sibling: the drop planner decides parent, order and re-spacing.
  const anchorRef = typeof args.before === 'string' ? args.before : typeof args.after === 'string' ? args.after : null;
  if (anchorRef) {
    const anchor = resolveNodeRef(env, context, anchorRef);
    if (!anchor) return fail(`No node "${anchorRef}" to move beside.`);
    const plan = planner.planPageTreeDrop(tree, dragged, anchor, typeof args.before === 'string' ? 'before' : 'after');
    if (!plan) return fail('Refused: that would put it inside itself, a subtype outside its base type, or it changes nothing.');
    if (plan.kind === 'unplace-item') {
      const result = await session.removeItemPlacement(plan.itemId);
      return result.ok ? { success: true } : fail(`The placement was refused: ${result.error}`);
    }
    if (plan.kind === 'page') {
      const page = findPage(context, plan.documentId)!;
      const sameParent = (page.parentFolderId ?? null) === plan.parentId
        && (plan.parentId === null || (page.parentKind ?? 'page') === plan.parentKind);
      if (!sameParent && planner.pageNameConflict(tree, page, plan.parentId, plan.parentKind)) {
        return fail(`A page named "${page.title}" already sits there.`);
      }
    }
    for (const write of [...(plan.renumber ?? []), plan]) {
      const error = await applyWrite(session, write);
      if (error) return fail(error);
    }
    return { success: true };
  }

  if (args.underType === true) {
    if (dragged.kind !== 'item') return fail('underType only applies to a typed page.');
    const result = planner.moveItemInTree(session, tree, dragged.itemId, { underType: true });
    if (result === 'cycle') return fail(INSIDE_ITSELF);
    const settled = await result;
    return settled.ok ? { success: true } : fail(`The placement was refused: ${settled.error}`);
  }

  const destination = typeof args.folderPath === 'string'
    ? await resolvePagePath(env, context, args.folderPath)
    : resolveParent(env, context, args.newParentFolderId, args.parentKind);
  if ('error' in destination) return fail(destination.error);
  const { parentId, parentKind } = destination;
  const sortOrder = typeof args.sortOrder === 'number' ? args.sortOrder : undefined;
  const target = { nodeId: planner.parentNodeIdOf(parentId, parentKind) };
  if (planner.treeMoveRefused(tree, moving.nodeId, target)) return fail(INSIDE_ITSELF);

  if (dragged.kind === 'page') {
    const page = findPage(context, dragged.documentId)!;
    // movePageInTree's checks, with the store's answer awaited instead of assumed.
    const sameParent = (page.parentFolderId ?? null) === parentId
      && (parentId === null || (page.parentKind ?? 'page') === parentKind);
    if (sameParent && sortOrder === undefined) return { success: true, outcome: 'unchanged' };
    if (!sameParent && planner.pageNameConflict(tree, page, parentId, parentKind)) return fail(`A page named "${page.title}" already sits there.`);
    const moved = session.movePage(page.documentId, parentId, { parentKind, ...(sortOrder !== undefined ? { sortOrder } : {}) });
    if (!moved) return fail(INSIDE_ITSELF);
    const result = await settled(moved, 'move');
    return result.success ? { success: true, outcome: sameParent ? 'reordered' : 'moved' } : result;
  }

  if (dragged.kind === 'item') {
    const result = await session.setItemPlacement(dragged.itemId, parentId, sortOrder, parentKind);
    return result.ok ? { success: true } : fail(`The placement was refused: ${result.error}`);
  }

  const base = context.resolver.typeExtends?.(dragged.typeId) ?? null;
  const placements = env.typePlacements(session);
  if (base && placements.some((placement) => placement.typeId === base)) {
    return fail(`"${dragged.typeId}" is a subtype of "${base}" and stays inside it in the tree.`);
  }
  return settled(placements.some((placement) => placement.typeId === dragged.typeId)
    ? session.moveTypePlacement(dragged.typeId, parentId, sortOrder, parentKind)
    : session.placeType(dragged.typeId, parentId, parentKind), 'placement');
}

/** What sits directly under a page: pages, placed types and placed typed pages. */
function pageChildCount(context: TreeContext, documentId: string): number {
  const node = context.nodes.get(`document:${documentId}`);
  return node ? childrenOf(node).length : 0;
}

export async function renamePageTool(env: PageTreeToolEnv, args: Record<string, unknown>): Promise<PageTreeToolResult> {
  const id = typeof args.itemId === 'string' ? args.itemId : '';
  const newName = typeof args.newName === 'string' ? args.newName.trim() : '';
  if (!id || !newName) return fail('Rename needs itemId and newName.');
  const context = await readTree(env, sectionOf(args.section));
  const page = findPage(context, id);
  if (!page || isTypePageDocumentId(id)) return fail(`No page "${id}" in the ${context.section} section. Rename a typed page with tracker_update.`);
  if (context.planner.pageNameConflict(context.tree, page, page.parentFolderId ?? null, page.parentKind, newName)) {
    return fail(`A page named "${newName}" already sits there.`);
  }
  return settled(context.session.updateDocumentTitle(id, newName), 'rename');
}

export async function deletePageTool(env: PageTreeToolEnv, args: Record<string, unknown>): Promise<PageTreeToolResult> {
  const id = typeof args.itemId === 'string' ? args.itemId : '';
  if (!id) return fail('Delete needs itemId.');
  const context = await readTree(env, sectionOf(args.section));
  const page = findPage(context, id);
  if (!page || isTypePageDocumentId(id)) return fail(`No page "${id}" in the ${context.section} section.`);
  const children = pageChildCount(context, id);
  if (args.kind === 'folder') {
    const removed = context.session.pageRemovalCount?.(id) ?? 0;
    const result = await settled(context.session.removePage(id), 'delete');
    return result.success ? { success: true, removedCount: removed + 1 } : result;
  }
  if (children > 0) {
    return fail(`"${page.title}" has ${children} child node(s). Move them first, or pass kind "folder" to remove the page with every page under it.`);
  }
  // Trash, never a permanent delete: a person can restore it from Trash.
  return settled(context.session.trashDocument(id), 'delete');
}

export async function setPageTypeTool(env: PageTreeToolEnv, args: Record<string, unknown>): Promise<PageTreeToolResult> {
  const pageId = typeof args.pageId === 'string' ? args.pageId : '';
  const typeId = typeof args.typeId === 'string' ? args.typeId : '';
  if (!pageId || !typeId) return fail('Set type needs pageId and typeId.');
  const context = await readTree(env, sectionOf(args.section));
  const page = findPage(context, pageId);
  if (!page || isTypePageDocumentId(pageId)) return fail(`No plain page "${pageId}" in the ${context.section} section.`);
  if (!context.resolver.typeName(typeId)) return fail(`"${typeId}" is not a ${context.section} type.`);
  // This tool is an agent's. A protected type (team-front, team-note, tool-manifest) is made
  // by the user, or by Nimbalyst, never by an agent turning a page into one; the Set type
  // picker in the sidebar does not go through here.
  if (isProtectedTrackerType(typeId)) {
    return fail(`"${typeId}" is a protected type: a tool does not turn a page into one. The user creates it in the Tracker.`);
  }
  const outcome = await env.setPageType(context.section, context.session, page, typeId);
  if (outcome.status === 'done') return { success: true, ...(outcome.itemId ? { itemId: outcome.itemId } : {}) };
  return fail(`${outcome.status === 'refused' ? 'Set type refused' : 'Set type did not finish'}: ${outcome.message ?? 'no reason given'}`);
}
