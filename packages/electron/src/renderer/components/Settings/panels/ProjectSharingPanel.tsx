import React from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { WorkspaceProjectSharingPanel } from './WorkspaceProjectSharingPanel';
import { ProjectAccessEditor } from './ProjectAccessEditor';

export type ProjectSettingsTarget =
  | { kind: 'workspace'; workspacePath: string }
  | { kind: 'organizationProject'; orgId: string; projectId: string };

function RemoteProjectSharing({ orgId, projectId }: { orgId: string; projectId: string }) {
  const { t } = useTranslation('settings');
  return (
    <div className="remote-project-sharing" data-testid="remote-project-sharing">
      <div className="project-identity-card mb-4 rounded-lg border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-4" data-testid="project-identity-card">
        <div className="flex items-center gap-2"><MaterialSymbol icon="cloud" size={18} /><span className="text-sm font-semibold">{t('projectSharing.remoteProjectTitle')}</span></div>
        <div className="mt-2 select-text text-xs text-[var(--nim-text-muted)]">{t('projectSharing.remoteProjectIds', { orgId, projectId })}</div>
      </div>
      <h3 className="m-0 mb-2 text-sm font-semibold">{t('projectSharing.peopleWithAccess')}</h3>
      <ProjectAccessEditor orgId={orgId} projectId={projectId} />
    </div>
  );
}

export function ProjectSharingPanel({ target }: { target?: ProjectSettingsTarget }) {
  const { t } = useTranslation('settings');
  return (
    <section className="project-sharing-panel" data-testid="project-sharing-panel" data-component="ProjectSharingPanel">
      <header className="mb-5 border-b border-[var(--nim-border)] pb-4"><h2 className="m-0 text-xl font-semibold">{t('projectSharing.title')}</h2><p className="m-0 mt-1 text-sm text-[var(--nim-text-muted)]">{t('projectSharing.description')}</p></header>
      {!target ? <p className="text-sm text-[var(--nim-text-muted)]">{t('projectSharing.noProject')}</p> : target.kind === 'workspace' ? <WorkspaceProjectSharingPanel workspacePath={target.workspacePath} /> : <RemoteProjectSharing orgId={target.orgId} projectId={target.projectId} />}
    </section>
  );
}
