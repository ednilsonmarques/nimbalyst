/**
 * PlanFilters - Search and filter controls for plans panel
 */

import type { JSX } from 'react';
import React from 'react';
import { useTranslation } from '@nimbalyst/runtime/i18n/react';

interface PlanFiltersProps {
  searchTerm: string;
  onSearchChange: (term: string) => void;
  statusFilter: string;
  onStatusChange: (status: string) => void;
  priorityFilter: string;
  onPriorityChange: (priority: string) => void;
  hideCompleted: boolean;
  onHideCompletedChange: (hide: boolean) => void;
}

export function PlanFilters({
  searchTerm,
  onSearchChange,
  statusFilter,
  onStatusChange,
  priorityFilter,
  onPriorityChange,
  hideCompleted,
  onHideCompletedChange
}: PlanFiltersProps): JSX.Element {
  const { t } = useTranslation('tracker');
  const statusOptions = [
    { value: 'all', label: t('plans.status.all') },
    { value: 'draft', label: t('plans.status.draft') },
    { value: 'ready-for-development', label: t('plans.status.ready') },
    { value: 'in-development', label: t('plans.status.inDevelopment') },
    { value: 'in-review', label: t('plans.status.inReview') },
    { value: 'completed', label: t('plans.status.completed') },
    { value: 'blocked', label: t('plans.status.blocked') },
    { value: 'rejected', label: t('plans.status.rejected') },
  ];

  const priorityOptions = [
    { value: 'all', label: t('plans.priorityAll') },
    { value: 'critical', label: t('priority.critical') },
    { value: 'high', label: t('priority.high') },
    { value: 'medium', label: t('priority.medium') },
    { value: 'low', label: t('priority.low') },
  ];

  return (
    <div className="plan-filters p-3 border-b border-[var(--nim-border)] bg-[var(--nim-bg)]">
      <div className="plan-search-container relative mb-2.5">
        <span className="plan-search-icon material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-lg text-[var(--nim-text-faint)] pointer-events-none">
          search
        </span>
        <input
          type="text"
          className="plan-search-input w-full py-2 pr-8 pl-9 border border-[var(--nim-border)] rounded-md bg-[var(--nim-bg)] text-[var(--nim-text)] text-[13px] outline-none transition-colors duration-150 placeholder:text-[var(--nim-text-faint)] focus:border-[var(--nim-border-focus)]"
          placeholder={t('plans.searchPlaceholder')}
          value={searchTerm}
          onChange={(e) => onSearchChange(e.target.value)}
        />
        {searchTerm && (
          <button
            className="plan-search-clear absolute right-1.5 top-1/2 -translate-y-1/2 bg-transparent border-none cursor-pointer p-1 flex items-center justify-center text-[var(--nim-text-faint)] rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)] [&_.material-symbols-outlined]:text-base"
            onClick={() => onSearchChange('')}
            aria-label={t('plans.clearSearch')}
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        )}
      </div>

      <div className="plan-filter-controls flex gap-2 mb-2.5">
        <select
          className="plan-filter-select flex-1 py-1.5 px-2 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-xs outline-none cursor-pointer transition-colors duration-150 hover:border-[var(--nim-primary)] focus:border-[var(--nim-border-focus)]"
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value)}
        >
          {statusOptions.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>

        <select
          className="plan-filter-select flex-1 py-1.5 px-2 border border-[var(--nim-border)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] text-xs outline-none cursor-pointer transition-colors duration-150 hover:border-[var(--nim-primary)] focus:border-[var(--nim-border-focus)]"
          value={priorityFilter}
          onChange={(e) => onPriorityChange(e.target.value)}
        >
          {priorityOptions.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="plan-filter-options flex items-center">
        <label className="plan-filter-checkbox flex items-center gap-1.5 text-xs text-[var(--nim-text-muted)] cursor-pointer select-none hover:text-[var(--nim-text)] [&_input]:cursor-pointer">
          <input
            type="checkbox"
            checked={hideCompleted}
            onChange={(e) => onHideCompletedChange(e.target.checked)}
          />
          <span>{t('plans.hideCompleted')}</span>
        </label>
      </div>
    </div>
  );
}
