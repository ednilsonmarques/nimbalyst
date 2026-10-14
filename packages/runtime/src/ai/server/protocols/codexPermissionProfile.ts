export interface CodexPermissionProfile {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy: 'untrusted' | 'never' | 'on-request';
  approvalsReviewer?: 'auto_review';
}

/**
 * A Team mode child's tool scope that Codex must honour natively: `read` and
 * `review` members investigate only. The host's MCP server already withholds
 * every denied Nimbalyst tool from such a session; this profile is Codex's
 * own half (its shell, its patches, its approvals).
 */
export type CodexRestrictedToolScope = 'read' | 'review';

/**
 * Translate Nimbalyst's persisted project permission pair into Codex's native
 * sandbox and approval controls.
 *
 * `bypass-all` remains literal unrestricted access unless the project opted
 * into Agent-verified checks. In that case Codex uses its low-friction local
 * automation preset and routes eligible approval requests through its
 * automatic reviewer.
 *
 * A restricted Team mode child (`restrictedScope`) ignores the project pair
 * entirely: the project's permissions describe what the USER allows an agent
 * in this workspace, the child's scope describes what this SESSION may do, and
 * the narrower one wins. It gets the `read-only` sandbox (no file write, no
 * network from commands) and the `untrusted` approval policy: Codex runs only
 * its own fixed set of known-safe read commands (ls, cat, grep, rg, sed -n,
 * git log/diff/status ...) without asking, and every other command, every
 * patch and every permission escalation becomes an approval request, which
 * the host refuses for a restricted thread (codexTeamPolicy.ts). The
 * automatic reviewer is never attached: an approval it would grant is an
 * escalation the session must not have.
 */
export function resolveCodexPermissionProfile(
  permissionMode: string | undefined,
  agentVerified: boolean,
  restrictedScope?: CodexRestrictedToolScope | null,
): CodexPermissionProfile {
  if (restrictedScope === 'read' || restrictedScope === 'review') {
    return {
      sandboxMode: 'read-only',
      approvalPolicy: 'untrusted',
    };
  }

  if (permissionMode === 'bypass-all' && agentVerified) {
    return {
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
    };
  }

  if (permissionMode === 'bypass-all') {
    return {
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    };
  }

  return {
    sandboxMode: 'workspace-write',
    approvalPolicy: 'never',
  };
}
