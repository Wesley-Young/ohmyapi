export const ccSwitchApps = [
  { id: 'claude', label: 'Claude Code', endpoint: '/v1/messages' },
  { id: 'codex', label: 'Codex', endpoint: '/v1/responses' },
] as const;

export type CCSwitchApp = (typeof ccSwitchApps)[number]['id'];

const primaryModel = { key: 'model', label: '主模型', required: true } as const;
const claudeModels = [
  { key: 'haikuModel', label: 'Haiku 模型', required: false },
  { key: 'sonnetModel', label: 'Sonnet 模型', required: false },
  { key: 'opusModel', label: 'Opus 模型', required: false },
] as const;

export function ccSwitchModelFields(app: CCSwitchApp) {
  return app === 'claude' ? [primaryModel, ...claudeModels] : [primaryModel];
}

export type CCSwitchModels = Partial<Record<'model' | 'haikuModel' | 'sonnetModel' | 'opusModel', string>>;

export function buildCCSwitchUrl(input: {
  app: CCSwitchApp;
  name: string;
  origin: string;
  apiKey: string;
  models: CCSwitchModels;
}) {
  const origin = new URL(input.origin).origin;
  const params = new URLSearchParams({
    resource: 'provider',
    app: input.app,
    name: input.name.trim(),
    endpoint: input.app === 'codex' ? `${origin}/v1` : origin,
    apiKey: input.apiKey,
    homepage: origin,
    enabled: 'true',
  });
  for (const field of ccSwitchModelFields(input.app)) {
    const value = input.models[field.key];
    if (value) params.set(field.key, value);
  }
  return `ccswitch://v1/import?${params.toString()}`;
}
