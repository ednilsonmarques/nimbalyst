/**
 * NIB.85 stage d0: card fields read from a markdown `board-table` (owner, due
 * date, priority, title, description) come from repository or AI-written
 * files, so they must reach the DOM as text, never as markup.
 */
import { describe, it, expect } from 'vitest';
import { createEditor, type LexicalEditor } from 'lexical';
import { $convertFromMarkdownString } from '@lexical/markdown';
import { BoardCardNode, $isCardNode, $createCardNode } from '../BoardCardNode';
import { BoardColumnContentNode } from '../BoardColumnContentNode';
import { BoardColumnHeaderNode } from '../BoardColumnHeaderNode';
import { BoardColumnNode } from '../BoardColumnNode';
import { BoardHeaderNode } from '../BoardHeaderNode';
import { KanbanBoardNode } from '../KanbanBoardNode';
import { BOARD_TABLE_TRANSFORMER } from '../BoardTableTransformer';

const IMG = '<img src=x onerror="window.__nibD0=true">';
const SCRIPT = '<script>window.__nibD0=true</script>';

function makeEditor(): LexicalEditor {
  return createEditor({
    namespace: 'board-hostile-test',
    nodes: [KanbanBoardNode, BoardHeaderNode, BoardColumnNode, BoardColumnHeaderNode, BoardColumnContentNode, BoardCardNode],
    onError: (e) => { throw e; },
  });
}

function boardMarkdown(row: { title: string; owner: string; due: string; priority: string }): string {
  return [
    '```board-table',
    '| Title | Status | Owner | Due Date | Priority |',
    '| --- | --- | --- | --- | --- |',
    `| ${row.title} | To Do | ${row.owner} | ${row.due} | ${row.priority} |`,
    '```',
  ].join('\n');
}

/** Import the markdown, then build the card's DOM exactly as Lexical would. */
function cardDomFor(markdown: string): { dom: HTMLElement; node: BoardCardNode; text: string; editor: LexicalEditor } {
  const editor = makeEditor();
  editor.update(() => { $convertFromMarkdownString(markdown, [BOARD_TABLE_TRANSFORMER]); }, { discrete: true });
  let out: { dom: HTMLElement; node: BoardCardNode; text: string } | null = null;
  editor.getEditorState().read(() => {
    const found: BoardCardNode[] = [];
    const walk = (n: any) => { if ($isCardNode(n)) found.push(n); n.getChildren?.().forEach(walk); };
    walk((editor.getEditorState() as any)._nodeMap.get('root'));
    expect(found.length).toBe(1);
    out = { dom: found[0].createDOM(), node: found[0], text: found[0].getTextContent() };
  });
  return { ...out!, editor };
}

function expectNoInjectedMarkup(dom: HTMLElement): void {
  expect(dom.querySelectorAll('img, script, iframe, svg, object, embed, link, style').length).toBe(0);
  expect(dom.querySelectorAll('[onerror], [onload], [onclick], [onmouseover]').length).toBe(0);
  // The only elements allowed are the card's own structure and its icon spans.
  for (const el of Array.from(dom.querySelectorAll('*'))) {
    expect(['DIV', 'SPAN', 'BUTTON', 'P', 'BR']).toContain(el.tagName);
  }
}

describe('BoardCardNode with hostile board-table fields (d0)', () => {
  it('renders a hostile owner as text, with no element created from the payload', () => {
    const { dom } = cardDomFor(boardMarkdown({ title: 'Task', owner: IMG, due: '2026-01-01', priority: 'high' }));
    expectNoInjectedMarkup(dom);
    const owner = dom.querySelector('.kanban-card-owner') as HTMLElement;
    expect(owner).not.toBeNull();
    expect(owner.textContent).toContain(IMG);
  });

  it('renders a hostile due date as text, with no element created from the payload', () => {
    const { dom } = cardDomFor(boardMarkdown({ title: 'Task', owner: 'ana', due: IMG, priority: 'low' }));
    expectNoInjectedMarkup(dom);
    expect((dom.querySelector('.kanban-card-due') as HTMLElement).textContent).toContain(IMG);
  });

  it('renders a script payload in the owner as text', () => {
    const { dom } = cardDomFor(boardMarkdown({ title: 'Task', owner: SCRIPT, due: '-', priority: '-' }));
    expectNoInjectedMarkup(dom);
    expect((dom.querySelector('.kanban-card-owner') as HTMLElement).textContent).toContain('<script>');
  });

  it('keeps a hostile title as the card text, not as markup', () => {
    const { dom, text } = cardDomFor(boardMarkdown({ title: IMG, owner: 'ana', due: '-', priority: '-' }));
    expectNoInjectedMarkup(dom);
    // The title is the card's Lexical child (a TextNode), rendered by the reconciler as text.
    expect(text).toContain(IMG);
  });

  it('does not let a hostile priority inject markup or leave an "undefined" icon', () => {
    const { dom } = cardDomFor(boardMarkdown({ title: 'Task', owner: 'ana', due: '-', priority: IMG }));
    expectNoInjectedMarkup(dom);
    expect(dom.textContent).not.toContain('undefined');
    expect(dom.querySelector('.kanban-card-priority')?.className ?? '').not.toMatch(/[<>"=]/);
  });

  it('keeps the icons and the visible text for ordinary fields (positive control)', () => {
    const { dom, text } = cardDomFor(boardMarkdown({ title: 'Ship it', owner: 'Ana Souza', due: '2026-12-31', priority: 'high' }));
    expect(dom.querySelector('.kanban-card-owner .material-symbols-outlined')?.textContent).toBe('person');
    expect(dom.querySelector('.kanban-card-owner')?.textContent).toContain('Ana Souza');
    expect(dom.querySelector('.kanban-card-due .material-symbols-outlined')?.textContent).toBe('calendar_today');
    expect(dom.querySelector('.kanban-card-due')?.textContent).toContain('2026-12-31');
    expect(dom.querySelector('.kanban-card-priority .material-symbols-outlined')?.textContent).toBe('error');
    expect(dom.querySelector('.kanban-card-priority')?.className).toContain('kanban-card-priority-high');
    expect(text).toContain('Ship it');
  });

  it('updateDOM also writes hostile fields as text', () => {
    const editor = makeEditor();
    let dom!: HTMLElement;
    editor.update(() => {
      const prev = $createCardNode('c1', { title: 't', owner: 'ana' });
      dom = prev.createDOM();
      const next = $createCardNode('c1', { title: 't', owner: IMG, dueDate: IMG, priority: IMG as unknown as 'low' });
      expect(next.updateDOM(prev, dom)).toBe(true);
    }, { discrete: true });
    expectNoInjectedMarkup(dom);
    expect((dom.querySelector('.kanban-card-owner') as HTMLElement).textContent).toContain(IMG);
  });
});
