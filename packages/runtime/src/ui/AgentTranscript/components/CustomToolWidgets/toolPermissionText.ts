/**
 * User-facing text of the tool permission prompt, localized.
 *
 * Presentation only: nothing here takes part in the permission decision. The
 * request payload keeps its English strings (they are also persisted in the
 * transcript); the widget translates what it recognizes and shows the rest
 * as it arrived.
 */

type Translate = (key: string, options?: Record<string, unknown>) => string;

const SIMPLE_PATTERN_KEYS: Record<string, string> = {
  Bash: 'shell',
  WebFetch: 'fetchAny',
  Edit: 'edit',
  Write: 'write',
  Read: 'read',
  Glob: 'glob',
  Grep: 'grep',
  WebSearch: 'webSearch',
  Task: 'task',
  TodoWrite: 'todoWrite',
};

/**
 * Localized name of a permission pattern, or null when the pattern is not one
 * this widget knows how to describe (the caller then falls back to the name
 * the request carried).
 */
export function describePermissionPattern(pattern: string, t: Translate): string | null {
  if (pattern.startsWith('Bash:compound:')) return t('toolPermission.patterns.compound');

  const bashMatch = pattern.match(/^Bash\(([^:]+):\*\)$/);
  if (bashMatch) return t('toolPermission.patterns.commands', { command: bashMatch[1] });

  const webfetchMatch = pattern.match(/^WebFetch\(domain:(.+)\)$/);
  if (webfetchMatch) return t('toolPermission.patterns.fetchFrom', { domain: webfetchMatch[1] });

  const simpleKey = SIMPLE_PATTERN_KEYS[pattern];
  if (simpleKey) return t(`toolPermission.patterns.${simpleKey}`);

  // MCP tools: mcp__server-name__tool_name -> "Server Name: Tool Name" (names, not prose).
  if (pattern.toLowerCase().startsWith('mcp__')) {
    const parts = pattern.split('__');
    if (parts.length >= 3) {
      const titleCase = (text: string, separator: string) =>
        text.split(separator).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
      return `${titleCase(parts[1], '-')}: ${titleCase(parts[2], '_')}`;
    }
  }
  return null;
}

// Sentences built by the permission hooks (AgentToolHooks.ts, toolAuthorization.ts).
// They are fixed strings in our own code; only the classifier reason is free text.
const CLASSIFIER_FLAGGED_PREFIX = 'Auto-mode classifier flagged this call: ';
const CLASSIFIER_APPROVAL = 'Auto-mode classifier requested user approval before running this tool.';
const COMPOUND_PART = 'This is part of a compound command - each part is checked separately';

/**
 * Classifier reasons seen so far, by their lower-cased English label. The SDK
 * sends the reason as free text, not as a code, so this list is necessarily
 * incomplete: an unknown reason is shown as it arrived.
 */
const KNOWN_CLASSIFIER_REASONS: Record<string, string> = {
  'unrequested commit in a connected app': 'unrequestedCommitInAConnectedApp',
  'untrusted code integration': 'untrustedCodeIntegration',
};

/** Translate a classifier reason such as "[Untrusted Code Integration]", keeping its brackets. */
export function localizeClassifierReason(reason: string, t: Translate): string {
  const trimmed = reason.trim();
  const bracketed = trimmed.match(/^\[(.*)\]$/);
  const label = (bracketed ? bracketed[1] : trimmed).trim();
  const key = KNOWN_CLASSIFIER_REASONS[label.toLowerCase()];
  if (!key) return trimmed;
  const translated = t(`toolPermission.classifierReasons.${key}`);
  return bracketed ? `[${translated}]` : translated;
}

/** Localize one warning line of a permission request; unknown lines pass through unchanged. */
export function localizePermissionWarning(warning: string, t: Translate): string {
  if (warning.startsWith(CLASSIFIER_FLAGGED_PREFIX)) {
    const reason = warning.slice(CLASSIFIER_FLAGGED_PREFIX.length);
    return t('toolPermission.warnings.classifierFlagged', { reason: localizeClassifierReason(reason, t) });
  }
  if (warning === CLASSIFIER_APPROVAL) return t('toolPermission.warnings.classifierApproval');
  if (warning === COMPOUND_PART) return t('toolPermission.warnings.compoundPart');
  return warning;
}
