import React, { useCallback } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { FilesEmptyTipDisplay } from '../tips/FilesEmptyTipDisplay';

export type WelcomeFileQuickPick = 'markdown' | 'mockup' | 'diagram';

interface WorkspaceWelcomeProps {
  workspaceName: string;
  hasWorkspace?: boolean;
  workspacePath?: string;
  onNewFile?: (fileType?: WelcomeFileQuickPick) => void;
  onFocusAgent?: () => void;
  onInsertAgentPrompt?: (prompt: string) => void;
}

let iconUrl: string | undefined;
try {
  iconUrl = new URL('/icon.png', import.meta.url).href;
} catch {
  iconUrl = undefined;
}

function handleCardKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  onActivate: () => void,
) {
  if (event.target !== event.currentTarget) return;
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  onActivate();
}

export function WorkspaceWelcome({
  workspaceName,
  hasWorkspace = false,
  workspacePath,
  onNewFile,
  onFocusAgent,
  onInsertAgentPrompt,
}: WorkspaceWelcomeProps) {
  const { t } = useTranslation('onboarding');
  const seedAgentPrompt = useCallback((prompt: string) => {
    onInsertAgentPrompt?.(prompt);
  }, [onInsertAgentPrompt]);

  return (
    <div className="workspace-welcome [container-type:inline-size] flex h-full w-full items-start justify-center overflow-y-auto bg-nim px-4 py-8 text-nim">
      <div className="workspace-welcome-content my-auto w-full max-w-[560px] text-center">
        <div className="workspace-welcome-icon mx-auto mb-4 h-16 w-16">
          {iconUrl && (
            <img
              src={iconUrl}
              alt="Nimbalyst"
              className="h-full w-full object-contain"
              onError={(event) => {
                (event.target as HTMLImageElement).style.display = 'none';
              }}
            />
          )}
        </div>
        <h1 className="workspace-welcome-title m-0 text-[1.75rem] font-semibold text-nim">
          {workspaceName}
        </h1>

        {hasWorkspace && workspacePath && (
          <>
            <p className="workspace-welcome-subtitle mb-8 mt-1.5 text-[13.5px] text-nim-faint">
              {t('workspaceWelcome.subtitle')}
            </p>

            <div className="workspace-welcome-actions grid grid-cols-1 gap-3 text-left">
              <div
                className="workspace-welcome-action-card rounded-xl border border-nim bg-nim-secondary p-4 transition-colors duration-150 hover:border-[color-mix(in_srgb,var(--nim-primary)_45%,var(--nim-border))] hover:bg-nim-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--nim-primary)]"
                role="button"
                tabIndex={0}
                aria-label={t('workspaceWelcome.newFile.ariaLabel')}
                onClick={() => onNewFile?.()}
                onKeyDown={(event) => handleCardKeyDown(event, () => onNewFile?.())}
              >
                <div className="workspace-welcome-action-header mb-2 flex items-center gap-2.5">
                  <div className="workspace-welcome-action-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--nim-primary)_20%,transparent)] bg-[color-mix(in_srgb,var(--nim-primary)_10%,transparent)] text-[var(--nim-primary)]">
                    <MaterialSymbol icon="note_add" size={17} />
                  </div>
                  <h2 className="m-0 text-sm font-semibold text-nim">{t('workspaceWelcome.newFile.title')}</h2>
                  <kbd className="ml-auto rounded border border-nim bg-nim px-1.5 py-0.5 font-[inherit] text-[11px] font-normal text-nim-faint">
                    ⌘N
                  </kbd>
                </div>
                <p className="m-0 text-[12.5px] leading-5 text-nim-muted">
                  {t('workspaceWelcome.newFile.description')}
                </p>
                <div className="workspace-welcome-quick-picks mt-2.5 flex flex-wrap gap-1.5">
                  {([
                    ['markdown', t('workspaceWelcome.newFile.markdown')],
                    ['mockup', t('workspaceWelcome.newFile.mockup')],
                    ['diagram', t('workspaceWelcome.newFile.diagram')],
                  ] as const).map(([fileType, label]) => (
                    <button
                      key={fileType}
                      type="button"
                      className="workspace-welcome-quick-pick cursor-pointer rounded-full border border-nim bg-nim px-2.5 py-[3px] text-[11.5px] text-nim-muted transition-colors duration-150 hover:border-[color-mix(in_srgb,var(--nim-primary)_45%,var(--nim-border))] hover:text-[var(--nim-primary)]"
                      onClick={(event) => {
                        event.stopPropagation();
                        onNewFile?.(fileType);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div
                className="workspace-welcome-action-card rounded-xl border border-nim bg-nim-secondary p-4 transition-colors duration-150 hover:border-[color-mix(in_srgb,var(--nim-primary)_45%,var(--nim-border))] hover:bg-nim-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--nim-primary)]"
                role="button"
                tabIndex={0}
                aria-label={t('workspaceWelcome.agent.ariaLabel')}
                onClick={onFocusAgent}
                onKeyDown={(event) => handleCardKeyDown(event, () => onFocusAgent?.())}
              >
                <div className="workspace-welcome-action-header mb-2 flex items-center gap-2.5">
                  <div className="workspace-welcome-action-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[color-mix(in_srgb,var(--nim-primary)_20%,transparent)] bg-[color-mix(in_srgb,var(--nim-primary)_10%,transparent)] text-[var(--nim-primary)]">
                    <MaterialSymbol icon="auto_awesome" size={17} />
                  </div>
                  <h2 className="m-0 text-sm font-semibold text-nim">{t('workspaceWelcome.agent.title')}</h2>
                </div>
                <p className="m-0 text-[12.5px] leading-5 text-nim-muted">
                  {t('workspaceWelcome.agent.description')}
                </p>
                <div className="workspace-welcome-prompt-picks mt-2.5 flex flex-wrap gap-1.5">
                  {([
                    ['summarize', t('workspaceWelcome.agent.summarizeProject'), 'Summarize this project'],
                    ['draftPlan', t('workspaceWelcome.agent.draftPlan'), 'Draft a plan for '],
                  ] as const).map(([id, label, prompt]) => (
                    <button
                      key={id}
                      type="button"
                      className="workspace-welcome-prompt-pick cursor-pointer rounded-full border border-nim bg-nim px-2.5 py-[3px] text-[11.5px] text-nim-muted transition-colors duration-150 hover:border-[color-mix(in_srgb,var(--nim-primary)_45%,var(--nim-border))] hover:text-[var(--nim-primary)]"
                      onClick={(event) => {
                        event.stopPropagation();
                        seedAgentPrompt(prompt);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <FilesEmptyTipDisplay
              workspacePath={workspacePath}
              onInsertPrompt={onInsertAgentPrompt}
            />
          </>
        )}
      </div>
    </div>
  );
}
