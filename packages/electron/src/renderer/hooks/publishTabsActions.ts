import { useEffect, type MutableRefObject } from 'react';

/**
 * Publishes the tabs actions owned by EditorMode into a ref that lives in App,
 * so useWindowLifecycle (beforeunload / unmount) and the document-edited sync
 * can read the real tab snapshot. Before NIB.97 App created a `useRef(null)`
 * that nobody assigned, so those paths always saw "no tabs".
 *
 * Returns the cleanup, which clears the ref only if it still holds these actions.
 */
export function publishTabsActions<T>(target: MutableRefObject<T | null> | undefined, actions: T): () => void {
  if (!target) return () => undefined;
  target.current = actions;
  return () => {
    if (target.current === actions) target.current = null;
  };
}

/** Effect wrapper used by EditorMode: publish on mount / when the actions change, clear on unmount. */
export function usePublishTabsActions<T>(target: MutableRefObject<T | null> | undefined, actions: T): void {
  useEffect(() => publishTabsActions(target, actions), [target, actions]);
}
