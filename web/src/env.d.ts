/** 构建时由 vite.config.ts 注入的 oma 版本；无法读取 git 信息时为 null。 */
declare const __OMA_VERSION__: { commit: string; date: string } | null;
