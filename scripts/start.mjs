process.env.NODE_ENV = 'production';

try {
  const { validateProductionConfig } = await import('../daemon/dist/config.js');
  validateProductionConfig();
  await import('../daemon/dist/index.js');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Failed to start ohmyapi');
  process.exitCode = 1;
}
