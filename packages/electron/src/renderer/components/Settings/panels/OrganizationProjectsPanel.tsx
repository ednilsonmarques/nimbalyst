import React, { useEffect, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

interface ProjectSummary {
  projectId: string;
  teamProjectId: string;
  name: string | null;
  slug: string | null;
  gitRemoteHash: string | null;
}

/**
 * Projects are added from the project they belong to, never by name here: the
 * add needs the workspace's git remote to key the project, and a name-only row
 * created an org project no workspace could ever resolve to.
 */
const ADD_PROJECT_HINT =
  'orgProjects.addProjectHint';

export function OrganizationProjectsPanel({
  orgId,
  onManageAccess,
}: {
  orgId?: string;
  onManageAccess: (orgId: string, projectId: string) => void;
}) {
  const { t } = useTranslation('settings');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) { setProjects([]); return; }
    void window.electronAPI.organization.listProjects(orgId).then((result) => {
      if (!result?.success) throw new Error(result?.error ?? t('orgProjects.errors.load'));
      setProjects(result.projects ?? []);
    }).catch((reason) => setError(String(reason)));
  }, [orgId, t]);

  return (
    <section className="organization-projects-panel" data-testid="organization-projects-panel" data-component="OrganizationProjectsPanel">
      <header className="mb-5 border-b border-[var(--nim-border)] pb-4">
        <h2 className="m-0 text-xl font-semibold">{t('orgProjects.title')}</h2>
        <p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]">{t('orgProjects.description')}</p>
      </header>
      <article className="organization-space-row mb-3 flex items-center gap-3 rounded-lg border border-dashed border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3 opacity-70" data-testid="organization-space-row">
        <MaterialSymbol icon="corporate_fare" size={20} />
        <div className="flex-1"><div className="text-sm font-medium">{t('orgProjects.space.title')}</div><div className="text-xs text-[var(--nim-text-muted)]">{t('orgProjects.space.description')}</div></div>
        <span className="text-[10px] uppercase text-[var(--nim-text-faint)]">{t('orgProjects.space.comingLater')}</span>
      </article>
      <div className="organization-project-list flex flex-col gap-2" data-testid="organization-project-list">
        {projects.map((project) => (
          <article key={project.projectId} className="organization-project-row flex items-center gap-3 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3" data-testid="organization-project-row">
            <MaterialSymbol icon="folder" size={20} />
            <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{project.name || project.slug || t('orgProjects.untitledProject')}</div><div className="truncate text-xs text-[var(--nim-text-muted)]">{project.gitRemoteHash ? t('orgProjects.gitLinked') : t('orgProjects.noLocalWorkspace')}</div></div>
            {orgId && <button type="button" className="project-manage-access rounded border border-[var(--nim-border)] px-3 py-1.5 text-xs hover:bg-[var(--nim-bg-hover)]" data-testid="project-manage-access" onClick={() => onManageAccess(orgId, project.projectId)}>{t('orgProjects.manageAccess')}</button>}
          </article>
        ))}
        {projects.length === 0 && (
          <p className="organization-projects-empty m-0 text-sm text-[var(--nim-text-muted)]" data-testid="organization-projects-empty">
            {t('orgProjects.empty')} {t(ADD_PROJECT_HINT)}
          </p>
        )}
      </div>
      {projects.length > 0 && (
        <p className="organization-add-project-hint m-0 mt-3 border-t border-[var(--nim-border)] pt-3 text-xs text-[var(--nim-text-muted)]" data-testid="organization-add-project-hint">
          {t(ADD_PROJECT_HINT)}
        </p>
      )}
      {error && <p className="select-text text-sm text-[var(--nim-error)]">{error}</p>}
    </section>
  );
}
