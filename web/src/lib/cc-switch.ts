export const ccSwitchApps = [
  { id: 'claude', label: 'Claude', endpoint: '/v1/messages' },
  { id: 'codex', label: 'Codex', endpoint: '/v1/responses' },
] as const;

type CCSwitchApp = (typeof ccSwitchApps)[number]['id'];

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
  /** 接入点的根地址，不带末尾斜杠。 */
  baseUrl: string;
  homepage: string;
  apiKey: string;
  models: CCSwitchModels;
}) {
  const params = new URLSearchParams({
    resource: 'provider',
    app: input.app,
    name: input.name.trim(),
    endpoint: input.app === 'codex' ? `${input.baseUrl}/v1` : input.baseUrl,
    apiKey: input.apiKey,
    homepage: input.homepage,
    enabled: 'true',
  });
  for (const field of ccSwitchModelFields(input.app)) {
    const value = input.models[field.key];
    if (value) params.set(field.key, value);
  }
  return `ccswitch://v1/import?${params.toString()}`;
}
