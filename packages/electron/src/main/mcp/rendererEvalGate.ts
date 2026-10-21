/**
 * renderer_eval runs arbitrary JavaScript in the app's renderer, so it is a development-only tool.
 * "Development" used to be NODE_ENV === 'development' or an ELECTRON_RENDERER_URL in the environment,
 * both of which a launching process can set; a packaged build never offers it, whatever the environment says.
 */
export interface RendererEvalGateInput {
  nodeEnv?: string;
  rendererUrl?: string;
  isPackaged: boolean;
}

export function isRendererEvalAvailable(input: RendererEvalGateInput): boolean {
  if (input.isPackaged) return false;
  return input.nodeEnv === 'development' || !!input.rendererUrl;
}
