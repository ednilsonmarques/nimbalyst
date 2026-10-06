import React, { useState, useEffect } from 'react';
import { getFileName } from '../../utils/pathUtils';
import { Trans, useTranslation } from '@nimbalyst/runtime/i18n/react';

export interface ProjectOption {
  path: string;
  name: string;
}

export interface ProjectSelectionDialogProps {
  isOpen: boolean;
  fileName: string;
  suggestedWorkspace?: string;
  onSelectProject: (projectPath: string) => void;
  onCancel: () => void;
}

export const ProjectSelectionDialog: React.FC<ProjectSelectionDialogProps> = ({
  isOpen,
  fileName,
  suggestedWorkspace,
  onSelectProject,
  onCancel
}) => {
  const { t } = useTranslation('workspace');
  const [recentProjects, setRecentProjects] = useState<ProjectOption[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      loadRecentProjects();
    }
  }, [isOpen]);

  const loadRecentProjects = async () => {
    try {
      const projects = await window.electronAPI.invoke('get-recent-workspaces');
      setRecentProjects(projects || []);

      // Pre-select suggested workspace if provided
      if (suggestedWorkspace) {
        setSelectedProject(suggestedWorkspace);
      }
    } catch (err) {
      console.error('Failed to load recent projects:', err);
      setRecentProjects([]);
    }
  };

  const handleBrowse = async () => {
    try {
      const result = await window.electronAPI.invoke('dialog-show-open-dialog', {
        properties: ['openDirectory', 'createDirectory']
      });

      if (!result.canceled && result.filePaths.length > 0) {
        onSelectProject(result.filePaths[0]);
      }
    } catch (err) {
      console.error('Failed to browse for project:', err);
    }
  };

  const handleCreateNew = async () => {
    try {
      const result = await window.electronAPI.invoke('dialog-show-open-dialog', {
        properties: ['openDirectory', 'createDirectory'],
        title: t('projectSelection.createDialogTitle'),
        buttonLabel: t('projectSelection.createDialogButton')
      });

      if (!result.canceled && result.filePaths.length > 0) {
        onSelectProject(result.filePaths[0]);
      }
    } catch (err) {
      console.error('Failed to create new project:', err);
    }
  };

  const handleUseSuggested = () => {
    if (suggestedWorkspace) {
      onSelectProject(suggestedWorkspace);
    }
  };

  const handleUseSelected = () => {
    if (selectedProject) {
      onSelectProject(selectedProject);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="project-selection-dialog-overlay nim-overlay"
      onClick={onCancel}
    >
      <div
        className="project-selection-dialog nim-modal min-w-[500px] max-w-[600px] max-h-[80vh] overflow-y-auto p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="project-selection-dialog-title m-0 mb-3 text-lg font-semibold text-[var(--nim-text)]">
          {t('projectSelection.title')}
        </h2>
        <p className="project-selection-dialog-message m-0 mb-6 text-sm text-[var(--nim-text-muted)] leading-relaxed">
          <Trans t={t} i18nKey="projectSelection.notInProject" values={{ fileName }} components={{ strong: <strong className="text-[var(--nim-text)] font-medium" /> }} />
          {suggestedWorkspace && <> {t('projectSelection.suggestedDetected')}</>}
        </p>

        {suggestedWorkspace && (
          <div className="project-selection-suggested mb-6 p-4 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-md">
            <h3 className="project-selection-section-title m-0 mb-3 text-sm font-semibold text-[var(--nim-text)] uppercase tracking-wide">
              {t('projectSelection.suggestedProject')}
            </h3>
            <div className="project-selection-suggested-item mb-3">
              <div className="project-selection-item-name text-sm font-medium text-[var(--nim-text)] mb-1">
                {getFileName(suggestedWorkspace)}
              </div>
              <div className="project-selection-item-path text-xs text-[var(--nim-text-faint)] font-mono">
                {suggestedWorkspace}
              </div>
            </div>
            <button
              className="project-selection-button project-selection-button-primary nim-btn-primary w-full"
              onClick={handleUseSuggested}
            >
              {t('projectSelection.useThisProject')}
            </button>
          </div>
        )}

        {recentProjects.length > 0 && (
          <div className="project-selection-recent mb-6">
            <h3 className="project-selection-section-title m-0 mb-3 text-sm font-semibold text-[var(--nim-text)] uppercase tracking-wide">
              {t('projectSelection.recentProjects')}
            </h3>
            <div className="project-selection-list mb-3 border border-[var(--nim-border)] rounded-md overflow-hidden max-h-[300px] overflow-y-auto">
              {recentProjects.map((project) => (
                <div
                  key={project.path}
                  className={`project-selection-item px-4 py-3 cursor-pointer border-b border-[var(--nim-border)] last:border-b-0 transition-colors duration-150 ${
                    selectedProject === project.path
                      ? 'selected bg-[var(--nim-primary)] [&_.project-selection-item-name]:text-white [&_.project-selection-item-path]:text-white'
                      : 'hover:bg-[var(--nim-bg-hover)]'
                  }`}
                  onClick={() => setSelectedProject(project.path)}
                >
                  <div className="project-selection-item-name text-sm font-medium text-[var(--nim-text)] mb-1">
                    {project.name}
                  </div>
                  <div className="project-selection-item-path text-xs text-[var(--nim-text-faint)] font-mono">
                    {project.path}
                  </div>
                </div>
              ))}
            </div>
            <button
              className="project-selection-button project-selection-button-primary nim-btn-primary w-full"
              onClick={handleUseSelected}
              disabled={!selectedProject}
            >
              {t('projectSelection.useSelectedProject')}
            </button>
          </div>
        )}

        <div className="project-selection-actions flex gap-3 mb-6">
          <button
            className="project-selection-button project-selection-button-secondary nim-btn-secondary flex-1"
            onClick={handleBrowse}
          >
            {t('projectSelection.browse')}
          </button>
          <button
            className="project-selection-button project-selection-button-secondary nim-btn-secondary flex-1"
            onClick={handleCreateNew}
          >
            {t('projectSelection.createNew')}
          </button>
        </div>

        <div className="project-selection-footer flex justify-end pt-4 border-t border-[var(--nim-border)]">
          <button
            className="project-selection-button project-selection-button-cancel nim-btn-secondary"
            onClick={onCancel}
          >
            {t('common:cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};
