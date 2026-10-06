import { type ContextOf, createPluginFactory, defineContext } from '@fraqjs/kernel';

export const AppContext = defineContext<void>()
  .subsystems(() => ({}))
  .builtins(() => ({}))
  .build();

export type AppContext = ContextOf<typeof AppContext>;
export const definePlugin = createPluginFactory<AppContext>();
