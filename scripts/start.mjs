import { createRequire } from 'node:module';

process.env.NODE_ENV = 'production';

/**
 * The daemon runs from source, and so must the @ohmyapi/* packages: without the condition Node would load their
 * dist, which may be missing or stale.
 */
function usesPackageSources() {
  try {
    return createRequire(new URL('../daemon/', import.meta.url))
      .resolve('@ohmyapi/protocols')
      .endsWith('.ts');
  } catch {
    return false;
  }
}

try {
  if (!usesPackageSources()) throw new Error('Start ohmyapi with pnpm start, or node --conditions=@ohmyapi/source');
  const { validateProductionConfig } = await import('../daemon/src/config.ts');
  validateProductionConfig();
  await import('../daemon/src/index.ts');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Failed to start ohmyapi');
  process.exitCode = 1;
}
