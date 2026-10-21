import { app } from 'electron';

import { buildAppOriginConfig, type AppOriginConfig } from './navigationPolicy';

let cached: AppOriginConfig | null = null;

/** The app's own renderer roots for this process (computed once). */
export function getAppOriginConfig(): AppOriginConfig {
  if (!cached) {
    cached = buildAppOriginConfig({
      env: {
        ELECTRON_RENDERER_URL: process.env.ELECTRON_RENDERER_URL,
        NODE_ENV: process.env.NODE_ENV,
        VITE_PORT: process.env.VITE_PORT,
      },
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
    });
  }
  return cached;
}
