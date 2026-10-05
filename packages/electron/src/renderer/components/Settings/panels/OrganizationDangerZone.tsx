import React, { useEffect, useState } from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';
import { ActionGuard } from './ActionGuard';
import { MergeOrgWizard } from './MergeOrgWizard';
import {
  bucketMemberCount,
  bucketProjectCount,
  categorizeTeamAnalyticsError,
  normalizeTeamAnalyticsCallerRole,
} from '../../../../shared/analytics/teamAnalytics';
import { trackTeamAnalyticsEvent } from '../../../utils/teamAnalytics';

export function OrganizationDangerZone({ orgId }: { orgId?: string }) {
  const { t } = useTranslation('settings');
  const [role, setRole] = useState('member');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [organizationName, setOrganizationName] = useState('');
  const [mergeCandidates, setMergeCandidates] = useState<Array<{ orgId: string; name: string }>>([]);
  const [projectCount, setProjectCount] = useState(0);
  const [memberCount, setMemberCount] = useState(0);
  const [showMerge, setShowMerge] = useState(false);
  useEffect(() => {
    if (!orgId) return;
    void Promise.all([
      window.electronAPI.organization.list(),
      window.electronAPI.organization.listMembers(orgId),
      window.electronAPI.organization.listProjects(orgId),
    ]).then(([directory, roster, projects]) => {
      const organizations = directory?.teams ?? [];
      const current = organizations.find((organization: { orgId: string }) => organization.orgId === orgId);
      setOrganizationName(current?.name ?? orgId);
      setRole(roster?.callerRole ?? 'member');
      setMemberCount(roster?.members?.length ?? 0);
      setProjectCount(projects?.projects?.length ?? 0);
      setMergeCandidates(organizations
        .filter((organization: { orgId: string; role: string; membershipType?: string }) =>
          organization.orgId !== orgId &&
          (!organization.membershipType || organization.membershipType === 'active_member') &&
          (organization.role === 'owner' || organization.role === 'admin'))
        .map((organization: { orgId: string; name: string }) => ({ orgId: organization.orgId, name: organization.name })));
    });
  }, [orgId]);
  const canDelete = role === 'owner' || role === 'admin';
  return (
    <section className="organization-danger-zone" data-testid="organization-danger-zone" data-component="OrganizationDangerZone">
      <h2 className="m-0 text-xl font-semibold text-[var(--nim-error)]">{t('orgDangerZone.title')}</h2>
      <p className="text-sm text-[var(--nim-text-muted)]">{t('orgDangerZone.description')}</p>
      <div className="mt-4 rounded-lg border border-[var(--nim-border)] p-4">
        <h3 className="m-0 text-sm font-semibold">{t('orgDangerZone.leave.title')}</h3>
        <p className="text-xs text-[var(--nim-text-muted)]">{t('orgDangerZone.leave.description')}</p>
        <ActionGuard allowed={false} reason={t('orgDangerZone.leave.disabledReason')}>
          <button type="button" disabled className="organization-leave rounded border border-[var(--nim-border)] px-3 py-2 text-sm disabled:opacity-40" data-testid="organization-leave">{t('orgDangerZone.leave.button')}</button>
        </ActionGuard>
      </div>
      <div className="mt-4 rounded-lg border border-[var(--nim-border)] p-4">
        <h3 className="m-0 text-sm font-semibold">{t('orgDangerZone.merge.title')}</h3>
        <p className="text-xs text-[var(--nim-text-muted)]">{t('orgDangerZone.merge.description')}</p>
        <ActionGuard allowed={canDelete && mergeCandidates.length > 0} reason={t('orgDangerZone.merge.disabledReason')}>
          <button type="button" className="organization-merge rounded border border-[var(--nim-border)] px-3 py-2 text-sm" data-testid="organization-merge" onClick={() => setShowMerge(true)}>{t('orgDangerZone.merge.button')}</button>
        </ActionGuard>
      </div>
      <div className="mt-4 rounded-lg border border-[var(--nim-border)] p-4">
        <h3 className="m-0 text-sm font-semibold">{t('orgDangerZone.transfer.title')}</h3>
        <p className="text-xs text-[var(--nim-text-muted)]">{t('orgDangerZone.transfer.description')}</p>
        <ActionGuard allowed={false} reason={t('orgDangerZone.transfer.disabledReason')}>
          <button type="button" disabled className="rounded border border-[var(--nim-border)] px-3 py-2 text-sm disabled:opacity-40" data-testid="organization-transfer-ownership">{t('orgDangerZone.transfer.button')}</button>
        </ActionGuard>
      </div>
      <div className="mt-4 rounded-lg border border-[var(--nim-error)] p-4">
        <h3 className="m-0 text-sm font-semibold">{t('orgDangerZone.delete.title')}</h3>
        <p className="text-xs text-[var(--nim-text-muted)]">{t('orgDangerZone.delete.description')}</p>
        <ActionGuard allowed={Boolean(orgId) && canDelete} reason={t('orgDangerZone.delete.disabledReason')}>
          <div className="flex gap-2"><input className="min-w-0 flex-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-3 py-2 text-sm" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /><button type="button" disabled={!orgId || confirmation !== orgId} className="rounded bg-[var(--nim-error)] px-3 py-2 text-sm font-semibold text-white disabled:opacity-40" onClick={() => orgId && void window.electronAPI.organization.deleteOrganization(orgId).then((result) => {
            if (result?.success) {
              trackTeamAnalyticsEvent('team_organization_deleted', {
                surface: 'desktop',
                callerRole: normalizeTeamAnalyticsCallerRole(role),
                memberCountBucket: bucketMemberCount(memberCount),
                projectCountBucket: bucketProjectCount(projectCount),
              });
              setMessage(t('orgDangerZone.delete.success'));
              // Refresh every org-directory surface so the deleted org stops
              // lingering in the switcher/roster (settings review finding).
              window.dispatchEvent(new CustomEvent('nimbalyst:organizations-changed'));
            } else {
              trackTeamAnalyticsEvent('team_operation_failed', {
                surface: 'desktop',
                operation: 'delete_organization',
                entryPoint: 'organization_manager',
                callerRole: normalizeTeamAnalyticsCallerRole(role),
                errorCategory: categorizeTeamAnalyticsError('organization', result?.error),
              });
              setMessage(result?.error ?? t('orgDangerZone.delete.failed'));
            }
          }).catch((error) => {
            trackTeamAnalyticsEvent('team_operation_failed', {
              surface: 'desktop',
              operation: 'delete_organization',
              entryPoint: 'organization_manager',
              callerRole: normalizeTeamAnalyticsCallerRole(role),
              errorCategory: categorizeTeamAnalyticsError('organization', error),
            });
            setMessage(error instanceof Error ? error.message : t('orgDangerZone.delete.failed'));
          })}>{t('common:delete')}</button></div>
        </ActionGuard>
      </div>
      {message && <p className="select-text text-sm">{message}</p>}
      {showMerge && orgId && (
        <MergeOrgWizard
          drainedOrg={{ orgId, name: organizationName || orgId }}
          survivorCandidates={mergeCandidates}
          projectCount={projectCount}
          memberCount={memberCount}
          onClose={() => setShowMerge(false)}
          onMerged={() => {
            setShowMerge(false);
            setMessage(t('orgDangerZone.merge.finished'));
            window.dispatchEvent(new CustomEvent('nimbalyst:organizations-changed'));
          }}
        />
      )}
    </section>
  );
}
