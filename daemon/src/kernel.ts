import { type ContextOf, createPluginFactory, defineContext } from '@fraqjs/kernel';

import type { AppConfig } from './config.ts';

export const AppContext = defineContext<AppConfig>()
  .subsystems(() => ({}))
  .builtins(({ rootOptions, parent }): { readonly config: AppConfig } => {
    const config = rootOptions ?? parent?.context.config;
    if (!config) throw new Error('Application config is required');
    return { config };
  })
  .build();

export type AppContext = ContextOf<typeof AppContext>;
export const definePlugin = createPluginFactory<AppContext>();
