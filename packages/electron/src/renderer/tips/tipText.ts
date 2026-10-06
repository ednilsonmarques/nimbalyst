/**
 * Localized text for a tip.
 *
 * Tip definitions keep their English source text (the action label is also
 * reported to analytics as-is), so the translation is resolved at render time
 * from `onboarding:tips.content.<tipId>.<field>`. Tips without a translation
 * entry fall back to the definition's own text.
 */

import type { TipDefinition } from './types';

export type TipTextField = 'title' | 'body' | 'action' | 'secondaryAction';

type Translate = (key: string, options: { defaultValue: string }) => string;

function sourceText(tip: TipDefinition, field: TipTextField): string {
  switch (field) {
    case 'title':
      return tip.content.title;
    case 'body':
      return tip.content.body;
    case 'action':
      return tip.content.action?.label ?? '';
    case 'secondaryAction':
      return tip.content.secondaryAction?.label ?? '';
  }
}

export function tipText(t: Translate, tip: TipDefinition, field: TipTextField): string {
  const source = sourceText(tip, field);
  return t(`onboarding:tips.content.${tip.id}.${field}`, { defaultValue: source });
}
