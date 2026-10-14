/**
 * The OpenAI Codex models this build knows without asking the network: the
 * provider's fallback catalog (served when the Codex CLI cannot list models)
 * and the only catalog Team mode consults when a member is created on
 * `openai-codex` (a member on a model nobody can validate is refused before
 * any side effect, see services/team/teamPolicy.ts in the host).
 */
export interface CodexCatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  maxTokens: number;
}

export const CODEX_FALLBACK_MODELS: ReadonlyArray<CodexCatalogModel> = Object.freeze([
  // GPT-6 catalog entries require codex >= 0.153.0 (Astra), >= 0.155.0
  // (Sol, Luna), and >= 0.159.1 (6.1 Sol); the catalog lists a 272k default
  // context window for all of them.
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', contextWindow: 272000, maxTokens: 128000 },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', contextWindow: 272000, maxTokens: 128000 },
  { id: 'gpt-6-astra', name: 'GPT-6 Astra', contextWindow: 272000, maxTokens: 128000 },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', contextWindow: 272000, maxTokens: 128000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', contextWindow: 372000, maxTokens: 128000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 372000, maxTokens: 128000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', contextWindow: 372000, maxTokens: 128000 },
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400000, maxTokens: 128000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 400000, maxTokens: 128000 },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 400000, maxTokens: 128000 },
].map((model) => Object.freeze(model)));

/** Whether a bare Codex model id (without the `openai-codex:` prefix) is in this build's catalog. */
export function isKnownCodexModelId(modelId: string | null | undefined): boolean {
  return typeof modelId === 'string' && CODEX_FALLBACK_MODELS.some((model) => model.id === modelId);
}
