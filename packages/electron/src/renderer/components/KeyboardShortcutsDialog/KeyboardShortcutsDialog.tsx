import React, { useState, useEffect } from 'react';
import { useAtomValue } from 'jotai';
import { KeyboardShortcuts, getShortcutDisplay } from '../../../shared/KeyboardShortcuts';
import {
  getRegisteredKeybindings,
  subscribeToCommandRegistry,
  type RegisteredKeybinding,
} from '../../extensions/commands/ExtensionCommandRegistry';
import { getExtensionLoader } from '@nimbalyst/runtime';
import { CANVAS_SHORTCUT_TABLE } from '@nimbalyst/runtime/canvas/canvasKeymap';
import { developerModeAtom } from '../../store/atoms/appSettings';
import { Trans, useTranslation } from '@nimbalyst/runtime/i18n/react';

interface KeyboardShortcutsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ShortcutGroup {
  title: string;
  shortcuts: Array<{
    label: string;
    shortcut: string;
  }>;
}

type TabId = 'general' | 'editor' | 'extensions';

const IS_MAC = navigator.platform.toUpperCase().indexOf('MAC') >= 0;

const canvasKeyTokens: Record<string, string> = {
  Mod: 'Cmd',
  ArrowLeft: '←',
  ArrowRight: '→',
  ArrowUp: '↑',
  ArrowDown: '↓',
  '+': 'Plus',
  '-': 'Minus',
};

// Shared across renders: never mutate this group or its shortcuts in place.
const canvasShortcuts: ShortcutGroup = {
  title: 'Project Canvas',
  shortcuts: CANVAS_SHORTCUT_TABLE.map(({ label, keys }) => ({
    label,
    shortcut: keys.map(key => canvasKeyTokens[key] ?? key).join('+'),
  })),
};

/**
 * Convert a manifest key string like "ctrl+shift+g" to the display format
 * compatible with getShortcutDisplay (e.g., "Ctrl+Shift+G").
 */
function formatManifestKey(key: string): string {
  return key
    .split('+')
    .map(part => {
      const lower = part.toLowerCase();
      if (lower === 'ctrl') return 'Ctrl';
      if (lower === 'cmd') return 'Cmd';
      if (lower === 'shift') return 'Shift';
      if (lower === 'alt') return 'Alt';
      if (lower === 'option') return 'Option';
      // Single character keys get uppercased, multi-char stay as-is
      return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join('+');
}

/**
 * Build extension shortcut groups from registered keybindings,
 * grouped by extension name.
 */
function buildExtensionShortcutGroups(keybindings: RegisteredKeybinding[]): ShortcutGroup[] {
  if (keybindings.length === 0) return [];

  // Group by extension ID
  const byExtension = new Map<string, RegisteredKeybinding[]>();
  for (const kb of keybindings) {
    const list = byExtension.get(kb.extensionId) ?? [];
    list.push(kb);
    byExtension.set(kb.extensionId, list);
  }

  // Resolve extension names
  const loader = getExtensionLoader();
  const groups: ShortcutGroup[] = [];

  for (const [extensionId, kbs] of byExtension) {
    const ext = loader.getExtension(extensionId);
    const title = ext?.manifest.name ?? extensionId;

    groups.push({
      title,
      shortcuts: kbs.map(kb => ({
        label: kb.commandTitle,
        shortcut: formatManifestKey(kb.key),
      })),
    });
  }

  return groups;
}

export function KeyboardShortcutsDialog({ isOpen, onClose }: KeyboardShortcutsDialogProps) {
  const { t } = useTranslation('general');
  const [activeTab, setActiveTab] = useState<TabId>('general');
  const [extensionGroups, setExtensionGroups] = useState<ShortcutGroup[]>([]);
  const developerMode = useAtomValue(developerModeAtom);

  // Handle Escape key to close dialog
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Subscribe to extension keybinding changes
  useEffect(() => {
    function sync() {
      setExtensionGroups(buildExtensionShortcutGroups(getRegisteredKeybindings()));
    }
    sync();
    const unsubscribe = subscribeToCommandRegistry(sync);
    return unsubscribe;
  }, []);

  if (!isOpen) return null;

  // Application shortcuts come from shared/KeyboardShortcuts.ts; canvas shortcuts come from the runtime keymap.
  const generalShortcuts: ShortcutGroup[] = [
    {
      title: t('keyboardShortcuts.groups.file'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.newFileNewSession'), shortcut: KeyboardShortcuts.file.newFile }, // shared/KeyboardShortcuts.ts:9 - Cmd+N
        { label: t('keyboardShortcuts.items.launchSessionPopup'), shortcut: KeyboardShortcuts.file.sessionLaunchPopup }, // shared/KeyboardShortcuts.ts:11 - Cmd+Shift+N
        { label: t('keyboardShortcuts.items.newTrackerItem'), shortcut: KeyboardShortcuts.file.trackerQuickCreate },
        { label: t('keyboardShortcuts.items.newBrowserTab'), shortcut: KeyboardShortcuts.file.newBrowserTab }, // shared/KeyboardShortcuts.ts:12 - Cmd+Shift+B
        { label: t('keyboardShortcuts.items.openFile'), shortcut: KeyboardShortcuts.file.open }, // shared/KeyboardShortcuts.ts:13 - Cmd+O
        { label: t('keyboardShortcuts.items.save'), shortcut: KeyboardShortcuts.file.save }, // shared/KeyboardShortcuts.ts:14 - Cmd+S
        { label: t('keyboardShortcuts.items.closeTab'), shortcut: KeyboardShortcuts.file.closeTab }, // shared/KeyboardShortcuts.ts:15 - Cmd+W
        { label: t('keyboardShortcuts.items.reopenClosedTab'), shortcut: KeyboardShortcuts.file.reopenClosedTab }, // shared/KeyboardShortcuts.ts:16 - Cmd+Shift+T
        { label: t('keyboardShortcuts.items.closeProject'), shortcut: KeyboardShortcuts.file.closeProject }, // shared/KeyboardShortcuts.ts:17 - Cmd+Shift+W
        { label: t('keyboardShortcuts.items.quit'), shortcut: KeyboardShortcuts.file.quit }, // shared/KeyboardShortcuts.ts:18 - Cmd+Q
      ],
    },
    {
      title: t('keyboardShortcuts.groups.edit'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.undo'), shortcut: KeyboardShortcuts.edit.undo }, // shared/KeyboardShortcuts.ts:23 - Cmd+Z
        { label: t('keyboardShortcuts.items.redo'), shortcut: KeyboardShortcuts.edit.redo }, // shared/KeyboardShortcuts.ts:24 - Cmd+Shift+Z
        { label: t('keyboardShortcuts.items.cut'), shortcut: KeyboardShortcuts.edit.cut }, // shared/KeyboardShortcuts.ts:25 - Cmd+X
        { label: t('keyboardShortcuts.items.copy'), shortcut: KeyboardShortcuts.edit.copy }, // shared/KeyboardShortcuts.ts:26 - Cmd+C
        { label: t('keyboardShortcuts.items.paste'), shortcut: KeyboardShortcuts.edit.paste }, // shared/KeyboardShortcuts.ts:28 - Cmd+V
        { label: t('keyboardShortcuts.items.pasteAsText'), shortcut: KeyboardShortcuts.edit.pasteAsText }, // shared/KeyboardShortcuts.ts:29 - Cmd+Shift+V
        { label: t('keyboardShortcuts.items.selectAll'), shortcut: KeyboardShortcuts.edit.selectAll }, // shared/KeyboardShortcuts.ts:29 - Cmd+A
        { label: t('keyboardShortcuts.items.find'), shortcut: KeyboardShortcuts.edit.find }, // shared/KeyboardShortcuts.ts:30 - Cmd+F
        { label: t('keyboardShortcuts.items.findNext'), shortcut: KeyboardShortcuts.edit.findNext }, // shared/KeyboardShortcuts.ts:31 - Cmd+G
        { label: t('keyboardShortcuts.items.findPrevious'), shortcut: KeyboardShortcuts.edit.findPrevious }, // shared/KeyboardShortcuts.ts:32 - Cmd+Shift+G
        { label: t('keyboardShortcuts.items.viewLocalHistory'), shortcut: KeyboardShortcuts.edit.viewHistory }, // shared/KeyboardShortcuts.ts:34 - Cmd+Y
        { label: t('keyboardShortcuts.items.approveCurrentAction'), shortcut: KeyboardShortcuts.edit.approve }, // shared/KeyboardShortcuts.ts:35 - Cmd+Enter
        { label: t('keyboardShortcuts.items.rejectCurrentAction'), shortcut: KeyboardShortcuts.edit.reject }, // shared/KeyboardShortcuts.ts:36 - Cmd+Shift+Backspace
        { label: t('keyboardShortcuts.items.togglePlanModeClaudeCode'), shortcut: 'Shift+Tab' }, // AIInput.tsx - toggle between Plan/Agent mode
        { label: t('keyboardShortcuts.items.chooseAIModelAIInputFocused'), shortcut: 'Cmd+Shift+M' }, // AIInput.tsx
        { label: t('keyboardShortcuts.items.nextPreviousAIMenuModelEffortActions'), shortcut: 'Tab / Shift+Tab' }, // AIInputControls.tsx
      ],
    },
    {
      title: t('keyboardShortcuts.groups.view'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.filesMode'), shortcut: KeyboardShortcuts.view.filesMode }, // shared/KeyboardShortcuts.ts:42 - Cmd+E
        { label: t('keyboardShortcuts.items.agentMode'), shortcut: KeyboardShortcuts.view.agentMode }, // shared/KeyboardShortcuts.ts:43 - Cmd+K
        { label: t('keyboardShortcuts.items.sessionKanbanView'), shortcut: KeyboardShortcuts.window.kanbanView }, // shared/KeyboardShortcuts.ts:81 - Cmd+Shift+K
        { label: t('keyboardShortcuts.items.toggleAIChatPanel'), shortcut: KeyboardShortcuts.view.toggleAIChat }, // shared/KeyboardShortcuts.ts:46 - Cmd+Shift+A
        { label: t('keyboardShortcuts.items.toggleBottomPanel'), shortcut: KeyboardShortcuts.view.toggleBottomPanel }, // shared/KeyboardShortcuts.ts:47 - Cmd+J
        { label: t('keyboardShortcuts.items.toggleTerminalPanel'), shortcut: KeyboardShortcuts.view.toggleTerminalPanel }, // shared/KeyboardShortcuts.ts:48 - Ctrl+`
        { label: t('keyboardShortcuts.items.toggleClaudeCLITerminalDrawer'), shortcut: KeyboardShortcuts.view.toggleCliTerminalDrawer }, // Ctrl+Shift+` — active claude-code-cli session only
        { label: t('keyboardShortcuts.items.trackerMode'), shortcut: KeyboardShortcuts.view.trackerMode }, // shared/KeyboardShortcuts.ts:49 - Cmd+T
        { label: t('keyboardShortcuts.items.pages'), shortcut: KeyboardShortcuts.view.collabMode }, // shared/KeyboardShortcuts.ts:50 - Cmd+D
        { label: t('keyboardShortcuts.items.organization'), shortcut: KeyboardShortcuts.view.orgMode }, // Cmd+Alt+M — only when the project belongs to an organization
        { label: t('keyboardShortcuts.items.toggleSidebar'), shortcut: KeyboardShortcuts.view.toggleSidebar }, // shared/KeyboardShortcuts.ts:51 - Cmd+B
        { label: t('keyboardShortcuts.items.toggleExpandedTab'), shortcut: KeyboardShortcuts.view.toggleExpandedTab }, // Shift+Escape — same as double-clicking a tab
        { label: t('keyboardShortcuts.items.navigateBack'), shortcut: KeyboardShortcuts.view.navigateBack }, // shared/KeyboardShortcuts.ts:52 - Cmd+[
        { label: t('keyboardShortcuts.items.navigateForward'), shortcut: KeyboardShortcuts.view.navigateForward }, // shared/KeyboardShortcuts.ts:53 - Cmd+]
        { label: t('keyboardShortcuts.items.nextTab'), shortcut: KeyboardShortcuts.view.nextTab }, // shared/KeyboardShortcuts.ts:56 - Cmd+Option+Right
        { label: t('keyboardShortcuts.items.previousTab'), shortcut: KeyboardShortcuts.view.prevTab }, // shared/KeyboardShortcuts.ts:57 - Cmd+Option+Left
        { label: t('keyboardShortcuts.items.actualSize'), shortcut: KeyboardShortcuts.view.actualSize }, // shared/KeyboardShortcuts.ts:60 - Cmd+0
        { label: t('keyboardShortcuts.items.zoomIn'), shortcut: KeyboardShortcuts.view.zoomIn }, // shared/KeyboardShortcuts.ts:61 - Cmd+Plus
        { label: t('keyboardShortcuts.items.zoomOut'), shortcut: KeyboardShortcuts.view.zoomOut }, // shared/KeyboardShortcuts.ts:62 - Cmd+-
        { label: t('keyboardShortcuts.items.toggleFullScreen'), shortcut: KeyboardShortcuts.view.toggleFullScreen }, // shared/KeyboardShortcuts.ts:70 - Ctrl+Cmd+F
      ],
    },
    {
      title: t('keyboardShortcuts.groups.window'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.projectManager'), shortcut: KeyboardShortcuts.window.workspaceManager }, // shared/KeyboardShortcuts.ts:75 - Cmd+P
        { label: t('keyboardShortcuts.items.switchProject'), shortcut: KeyboardShortcuts.window.projectQuickOpen }, // shared/KeyboardShortcuts.ts - Cmd+Shift+P
        { label: t('keyboardShortcuts.items.sessionQuickOpen'), shortcut: KeyboardShortcuts.window.sessionQuickOpen }, // shared/KeyboardShortcuts.ts:77 - Cmd+L
        { label: t('keyboardShortcuts.items.promptQuickOpen'), shortcut: KeyboardShortcuts.window.promptQuickOpen }, // shared/KeyboardShortcuts.ts:78 - Cmd+Shift+L
        { label: t('keyboardShortcuts.items.contentSearch'), shortcut: KeyboardShortcuts.window.contentSearch }, // shared/KeyboardShortcuts.ts:79 - Cmd+Shift+F
        { label: t('keyboardShortcuts.items.memorySearch'), shortcut: KeyboardShortcuts.window.globalSearch }, // shared/KeyboardShortcuts.ts - Cmd+Shift+O
        { label: t('keyboardShortcuts.items.teamQuickOpen'), shortcut: KeyboardShortcuts.window.teamQuickOpen }, // shared/KeyboardShortcuts.ts - Cmd+Shift+D
        { label: t('keyboardShortcuts.items.organizationMessages'), shortcut: KeyboardShortcuts.window.organizationManager },
        { label: t('keyboardShortcuts.items.newWorktree'), shortcut: KeyboardShortcuts.window.newWorktree }, // shared/KeyboardShortcuts.ts:81 - Cmd+Alt+W
        { label: t('keyboardShortcuts.items.settings'), shortcut: KeyboardShortcuts.window.aiModels }, // shared/KeyboardShortcuts.ts:82 - Cmd+,
        { label: t('keyboardShortcuts.items.minimize'), shortcut: KeyboardShortcuts.window.minimize }, // shared/KeyboardShortcuts.ts:83 - Cmd+M
      ],
    },
    {
      // Live only while the Organization window is focused — the application
      // menu swaps them in and out with it, so Cmd+K and Cmd+F keep their
      // project-window meanings everywhere else.
      title: t('keyboardShortcuts.groups.organizationWindowMessages'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.newMessage'), shortcut: KeyboardShortcuts.orgWindow.newMessage }, // shared/KeyboardShortcuts.ts - Cmd+K
        { label: t('keyboardShortcuts.items.goToInbox'), shortcut: KeyboardShortcuts.orgWindow.goToInbox }, // shared/KeyboardShortcuts.ts - Cmd+I
        { label: t('keyboardShortcuts.items.searchMessages'), shortcut: KeyboardShortcuts.orgWindow.searchMessages }, // shared/KeyboardShortcuts.ts - Cmd+F
        { label: t('keyboardShortcuts.items.nextConversation'), shortcut: KeyboardShortcuts.orgWindow.nextConversation }, // shared/KeyboardShortcuts.ts - Cmd+Shift+]
        { label: t('keyboardShortcuts.items.previousConversation'), shortcut: KeyboardShortcuts.orgWindow.previousConversation }, // shared/KeyboardShortcuts.ts - Cmd+Shift+[
        { label: t('keyboardShortcuts.items.markAllAsRead'), shortcut: KeyboardShortcuts.orgWindow.markAllRead }, // shared/KeyboardShortcuts.ts - Cmd+Shift+U
      ],
    },
    {
      title: t('keyboardShortcuts.groups.trackerGrid'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.moveBetweenCells'), shortcut: t('keyboardShortcuts.keys.arrowKeysOrTab') },
        { label: t('keyboardShortcuts.items.editFocusedCell'), shortcut: t('keyboardShortcuts.keys.f2OrType') },
        { label: t('keyboardShortcuts.items.openFocusedItemDetails'), shortcut: 'Enter' },
        { label: t('keyboardShortcuts.items.commitEditNextRow'), shortcut: t('keyboardShortcuts.keys.enterWhileEditing') },
        { label: t('keyboardShortcuts.items.cancelEditCloseDetails'), shortcut: 'Escape' },
        { label: t('keyboardShortcuts.items.undoLastGridEdit'), shortcut: IS_MAC ? '⌘+Z' : 'Ctrl+Z' },
        { label: t('keyboardShortcuts.items.redoGridEdit'), shortcut: IS_MAC ? '⌘+Shift+Z' : 'Ctrl+Shift+Z' },
      ],
    },
    { ...canvasShortcuts, title: t('keyboardShortcuts.groups.projectCanvas') },
  ];

  // Editor shortcuts are defined in: packages/runtime/src/editor/plugins/ShortcutsPlugin/shortcuts.ts
  const editorShortcuts: ShortcutGroup[] = [
    {
      title: t('keyboardShortcuts.groups.textFormatting'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.bold'), shortcut: IS_MAC ? '⌘+B' : 'Ctrl+B' }, // shortcuts.ts:48 - BOLD
        { label: t('keyboardShortcuts.items.italic'), shortcut: IS_MAC ? '⌘+I' : 'Ctrl+I' }, // shortcuts.ts:49 - ITALIC
        { label: t('keyboardShortcuts.items.underline'), shortcut: IS_MAC ? '⌘+U' : 'Ctrl+U' }, // shortcuts.ts:50 - UNDERLINE
        { label: t('keyboardShortcuts.items.strikethrough'), shortcut: IS_MAC ? '⌘+Shift+X' : 'Ctrl+Shift+X' }, // shortcuts.ts:31 - STRIKETHROUGH
        { label: t('keyboardShortcuts.items.insertLink'), shortcut: IS_MAC ? '⌘+K' : 'Ctrl+K' }, // shortcuts.ts:51 - INSERT_LINK
        { label: t('keyboardShortcuts.items.clearFormatting'), shortcut: IS_MAC ? '⌘+\\' : 'Ctrl+\\' }, // shortcuts.ts:45 - CLEAR_FORMATTING
      ],
    },
    {
      title: t('keyboardShortcuts.groups.paragraphFormatting'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.normalText'), shortcut: IS_MAC ? '⌘+Opt+0' : 'Ctrl+Alt+0' }, // shortcuts.ts:16 - NORMAL
        { label: t('keyboardShortcuts.items.heading1'), shortcut: IS_MAC ? '⌘+Opt+1' : 'Ctrl+Alt+1' }, // shortcuts.ts:17 - HEADING1
        { label: t('keyboardShortcuts.items.heading2'), shortcut: IS_MAC ? '⌘+Opt+2' : 'Ctrl+Alt+2' }, // shortcuts.ts:18 - HEADING2
        { label: t('keyboardShortcuts.items.heading3'), shortcut: IS_MAC ? '⌘+Opt+3' : 'Ctrl+Alt+3' }, // shortcuts.ts:19 - HEADING3
        { label: t('keyboardShortcuts.items.numberedList'), shortcut: IS_MAC ? '⌘+Shift+7' : 'Ctrl+Shift+7' }, // shortcuts.ts:20 - NUMBERED_LIST
        { label: t('keyboardShortcuts.items.bulletList'), shortcut: IS_MAC ? '⌘+Shift+8' : 'Ctrl+Shift+8' }, // shortcuts.ts:21 - BULLET_LIST
        { label: t('keyboardShortcuts.items.checkList'), shortcut: IS_MAC ? '⌘+Shift+9' : 'Ctrl+Shift+9' }, // shortcuts.ts:22 - CHECK_LIST
        { label: t('keyboardShortcuts.items.codeBlock'), shortcut: IS_MAC ? '⌘+Opt+C' : 'Ctrl+Alt+C' }, // shortcuts.ts:23 - CODE_BLOCK
        { label: t('keyboardShortcuts.items.quote'), shortcut: IS_MAC ? '⌃+Shift+Q' : 'Ctrl+Shift+Q' }, // shortcuts.ts:24 - QUOTE
      ],
    },
    {
      title: t('keyboardShortcuts.groups.textAlignment'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.leftAlign'), shortcut: IS_MAC ? '⌘+Shift+L' : 'Ctrl+Shift+L' }, // shortcuts.ts:37 - LEFT_ALIGN
        { label: t('keyboardShortcuts.items.centerAlign'), shortcut: IS_MAC ? '⌘+Shift+E' : 'Ctrl+Shift+E' }, // shortcuts.ts:35 - CENTER_ALIGN
        { label: t('keyboardShortcuts.items.rightAlign'), shortcut: IS_MAC ? '⌘+Shift+R' : 'Ctrl+Shift+R' }, // shortcuts.ts:38 - RIGHT_ALIGN
        { label: t('keyboardShortcuts.items.justify'), shortcut: IS_MAC ? '⌘+Shift+J' : 'Ctrl+Shift+J' }, // shortcuts.ts:36 - JUSTIFY_ALIGN
        { label: t('keyboardShortcuts.items.indent'), shortcut: IS_MAC ? '⌘+]' : 'Ctrl+]' }, // shortcuts.ts:43 - INDENT
        { label: t('keyboardShortcuts.items.outdent'), shortcut: IS_MAC ? '⌘+[' : 'Ctrl+[' }, // shortcuts.ts:44 - OUTDENT
      ],
    },
    {
      title: t('keyboardShortcuts.groups.textCaseAndSize'),
      shortcuts: [
        { label: t('keyboardShortcuts.items.lowercase'), shortcut: IS_MAC ? '⌃+Shift+1' : 'Ctrl+Shift+1' }, // shortcuts.ts:32 - LOWERCASE
        { label: t('keyboardShortcuts.items.uppercase'), shortcut: IS_MAC ? '⌃+Shift+2' : 'Ctrl+Shift+2' }, // shortcuts.ts:33 - UPPERCASE
        { label: t('keyboardShortcuts.items.capitalize'), shortcut: IS_MAC ? '⌃+Shift+3' : 'Ctrl+Shift+3' }, // shortcuts.ts:34 - CAPITALIZE
        { label: t('keyboardShortcuts.items.increaseFontSize'), shortcut: IS_MAC ? '⌘+Shift+.' : 'Ctrl+Shift+.' }, // shortcuts.ts:28 - INCREASE_FONT_SIZE
        { label: t('keyboardShortcuts.items.decreaseFontSize'), shortcut: IS_MAC ? '⌘+Shift+,' : 'Ctrl+Shift+,' }, // shortcuts.ts:29 - DECREASE_FONT_SIZE
        { label: t('keyboardShortcuts.items.subscript'), shortcut: IS_MAC ? '⌘+,' : 'Ctrl+,' }, // shortcuts.ts:41 - SUBSCRIPT
        { label: t('keyboardShortcuts.items.superscript'), shortcut: IS_MAC ? '⌘+.' : 'Ctrl+.' }, // shortcuts.ts:42 - SUPERSCRIPT
      ],
    },
  ];

  if (developerMode) {
    const viewGroup = generalShortcuts.find((group) => group.title === t('keyboardShortcuts.groups.view'));
    viewGroup?.shortcuts.splice(8, 0, {
      label: 'GitHub',
      shortcut: KeyboardShortcuts.view.prReviewMode,
    });
  }

  const shortcutGroups = activeTab === 'general'
    ? generalShortcuts
    : activeTab === 'editor'
    ? editorShortcuts
    : extensionGroups;

  return (
    <div
      className="keyboard-shortcuts-dialog-overlay nim-overlay"
      onClick={onClose}
    >
      <div
        className="keyboard-shortcuts-dialog flex flex-col w-[90vw] max-w-[900px] h-[85vh] rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg)] shadow-[0_8px_32px_rgba(0,0,0,0.3)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="keyboard-shortcuts-dialog-header flex items-center justify-between px-6 py-5 border-b border-[var(--nim-border)]">
          <h2 className="m-0 text-xl font-semibold text-[var(--nim-text)]">
            {t('keyboardShortcuts.title')}
          </h2>
          <button
            className="keyboard-shortcuts-dialog-close flex items-center justify-center w-8 h-8 p-0 bg-transparent border-none text-[32px] leading-none text-[var(--nim-text-muted)] cursor-pointer rounded transition-all duration-200 hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
            onClick={onClose}
            aria-label={t('common:close')}
          >
            ×
          </button>
        </div>

        {/* Tab navigation */}
        <div className="flex gap-1 px-6 pt-4 border-b border-[var(--nim-border)]">
          {(['general', 'editor', 'extensions'] as TabId[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm font-medium rounded-t-md transition-colors ${
                activeTab === tab
                  ? 'bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] border-b-2 border-[var(--nim-primary)]'
                  : 'text-[var(--nim-text-muted)] hover:text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]'
              }`}
            >
              {tab === 'general' ? t('keyboardShortcuts.tabs.general') : tab === 'editor' ? t('keyboardShortcuts.tabs.editor') : t('keyboardShortcuts.tabs.extensions')}
            </button>
          ))}
        </div>

        <div className="keyboard-shortcuts-dialog-content overflow-y-auto flex-1 p-6 grid grid-cols-[repeat(auto-fit,minmax(350px,1fr))] gap-8 max-[900px]:grid-cols-1 max-[600px]:p-5 max-[600px]:gap-6">
          {shortcutGroups.length === 0 && activeTab === 'extensions' ? (
            <div className="text-[var(--nim-text-muted)] text-sm">
              {t('keyboardShortcuts.noExtensionKeybindings')}
            </div>
          ) : (
            shortcutGroups.map((group) => (
              <div key={group.title} className="keyboard-shortcuts-group flex flex-col gap-3">
                <h3 className="keyboard-shortcuts-group-title m-0 text-sm font-semibold text-[var(--nim-text-muted)] uppercase tracking-[0.5px]">
                  {group.title}
                </h3>
                <div className="keyboard-shortcuts-list flex flex-col gap-1">
                  {group.shortcuts.map((item) => (
                    <div
                      key={item.label}
                      className="keyboard-shortcut-item flex items-center justify-between py-1.5 gap-4"
                    >
                      <span className="keyboard-shortcut-label text-[var(--nim-text)] text-sm flex-1">
                        {item.label}
                      </span>
                      <kbd className="keyboard-shortcut-key bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded px-2.5 py-1 font-sans text-[13px] font-medium text-[var(--nim-text)] whitespace-nowrap shadow-[0_1px_2px_rgba(0,0,0,0.1)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3)] min-w-[60px] text-center">
                        {getShortcutDisplay(item.shortcut)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="px-6 py-3 border-t border-[var(--nim-border)] text-[var(--nim-text-muted)] text-xs">
          <Trans t={t} i18nKey="keyboardShortcuts.pressEscToClose" components={{ kbd: <kbd className="bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded px-1.5 py-0.5 mx-1" /> }} />
        </div>
      </div>
    </div>
  );
}
