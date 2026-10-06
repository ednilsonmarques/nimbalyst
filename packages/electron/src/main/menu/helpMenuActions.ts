/**
 * Click handlers for Help menu items that need more than a `shell.openExternal`
 * call. Kept out of ApplicationMenu.ts so they can be unit tested without
 * loading the whole menu module's dependency graph.
 */
import { dialog } from 'electron';
import { logger } from '../utils/logger';
import { t } from '@nimbalyst/runtime/i18n';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { startTutorialProject } from '../window/WorkspaceManagerWindow.ts';

/**
 * Help > Launch Tutorial. Materializes the tutorial project if it isn't on disk
 * yet, then opens it (or focuses the window that already has it).
 */
export async function launchTutorialFromMenu(): Promise<void> {
    AnalyticsService.getInstance().sendEvent('help_accessed', {
        helpType: 'tutorial',
        context: 'menu',
    });

    const result = await startTutorialProject('help_menu');
    if (!result.success) {
        logger.menu.error('Failed to launch tutorial:', result.error);
        dialog.showErrorBox(
            t('menu:help.tutorialUnavailable.title'),
            t('menu:help.tutorialUnavailable.message', { error: result.error })
        );
    }
}
