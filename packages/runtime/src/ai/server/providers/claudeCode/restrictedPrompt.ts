import type { ChildToolScope } from './toolPolicy';

/**
 * Built-in slash commands a read/review child may still receive as commands.
 * Nimbalyst itself sends `/context` to measure context usage (AIService
 * runAutoContextCommand); `/compact` and `/clear` only act on the conversation.
 * Everything else that starts with "/" (skills, plugin commands, custom
 * commands, `/init`, ...) reaches the model as plain text: the CLI runs a slash
 * skill without the Skill tool, and such a skill's frontmatter hooks ran a
 * shell command while Bash was denied (scope probe P6, 2026-10-13).
 */
export const RESTRICTED_SCOPE_SLASH_ALLOWLIST: readonly string[] = ['/context', '/compact', '/clear'];

/** Prefix that turns a would-be slash command into plain text for the model. */
export const RESTRICTED_SCOPE_SLASH_NOTICE =
  '[Nimbalyst] Slash commands are not available in this restricted (read/review) session; the line below arrived as plain text, not as a command.\n\n';

export interface RestrictedPromptResult {
  message: string;
  neutralized: boolean;
}

export function isRestrictedToolScope(scope: ChildToolScope | undefined): scope is 'read' | 'review' {
  return scope === 'read' || scope === 'review';
}

/**
 * For a read/review child, a prompt that begins with "/" is delivered as plain
 * text unless its command is on the allowlist. Other scopes, unscoped sessions
 * and ordinary prompts are returned untouched. A "!" prefix needs no handling:
 * the SDK delivers it as plain text (probe P6d).
 */
export function neutralizeRestrictedPrompt(message: string, scope: ChildToolScope | undefined): RestrictedPromptResult {
  if (!isRestrictedToolScope(scope)) return { message, neutralized: false };
  const trimmed = message.trimStart();
  if (!trimmed.startsWith('/')) return { message, neutralized: false };
  const command = trimmed.split(/\s/, 1)[0];
  if (RESTRICTED_SCOPE_SLASH_ALLOWLIST.includes(command)) return { message, neutralized: false };
  return { message: RESTRICTED_SCOPE_SLASH_NOTICE + trimmed, neutralized: true };
}
