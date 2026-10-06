/**
 * Navigation Introduction Walkthroughs
 *
 * Two context-aware walkthroughs that introduce users to the OTHER mode:
 * - In Files mode: introduces Agent Mode
 * - In Agent mode: introduces Files Mode
 */

import type { WalkthroughDefinition } from '../types';

/**
 * Shown in Files mode to introduce Agent Mode.
 */
export const agentModeIntro: WalkthroughDefinition = {
  id: 'agent-mode-intro',
  name: 'Agent Mode Introduction',
  version: 1,
  trigger: {
    screen: 'files',
    delay: 500,
    priority: 5,
  },
  steps: [
    {
      id: 'agent-mode',
      target: {
        testId: 'agent-mode-button',
      },
      title: 'walkthroughs.agentMode.title',
      body: 'walkthroughs.agentMode.body',
      placement: 'right',
      shortcut: 'Cmd+2',
    },
  ],
};

/**
 * Shown in Agent mode to introduce Files Mode.
 */
export const filesModeIntro: WalkthroughDefinition = {
  id: 'files-mode-intro',
  name: 'Files Mode Introduction',
  version: 1,
  trigger: {
    screen: 'agent',
    delay: 500,
    priority: 5,
  },
  steps: [
    {
      id: 'files-mode',
      target: {
        testId: 'files-mode-button',
      },
      title: 'walkthroughs.filesMode.title',
      body: 'walkthroughs.filesMode.body',
      placement: 'right',
      shortcut: 'Cmd+1',
    },
  ],
};
