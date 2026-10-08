/**
 * 参考 new-api/tokenkit/image.go 的未知尺寸路径（2026-10-09）。
 * 按 1024×1024 和模型/detail 估算；URL、文件引用和 Base64 均不读取或持久化。
 * 这些是断连兜底值，上游报告的输入用量优先。
 */
export function estimateImageTokens(model: string, detail: unknown): number {
  const name = model.toLowerCase().split('/').at(-1) ?? '';
  const level = typeof detail === 'string' ? detail.toLowerCase() : 'auto';
  const patch = (multiplier: number, patches = 1024) => Math.ceil(patches * Math.fround(multiplier));
  const tile = (base: number, perTile: number) => base + (level === 'low' ? 0 : 4 * perTile);
  const gpt = name.match(/^gpt-(\d+)(?:\.(\d+))?(?:-|$)/);
  if (gpt) {
    const major = Number(gpt[1]);
    const minor = Number(gpt[2] ?? 0);
    if (major >= 6 || (major === 5 && minor >= 5))
      return patch(1.2, level === 'low' ? 256 : major === 5 && level === 'high' ? 576 : 1024);
    if (major === 5 && minor >= 2) return patch(1.2);
    if (major === 5 && minor === 0 && name.includes('nano')) return patch(1.5);
    if (major === 5 && minor === 0 && name.includes('mini')) return patch(1.2);
    if (major === 5) return tile(70, 140);
    if (major === 4 && minor === 1 && name.includes('mini')) return patch(1.62);
    if (major === 4 && minor === 1 && name.includes('nano')) return patch(2.46);
    return tile(85, 170);
  }
  if (name.startsWith('gpt-4o-mini')) return tile(2833, 5667);
  if (name.startsWith('gpt-4o')) return tile(85, 170);
  if (/^o4-mini(?:-|$)/.test(name)) return patch(1.72);
  if (/^o[13](?:-|$)/.test(name)) return tile(75, 150);
  if (name.startsWith('claude-')) {
    // 1024×1024 在两档尺寸限制内，差异来自图像封装 Token。
    const version = name.slice(7).match(/(?:^|-)(\d{1,2})(?:[.-](\d{1,2}))?(?=-|$)/);
    const highResolution =
      !version || Number(version[1]) > 4 || (Number(version[1]) === 4 && Number(version[2] ?? 0) >= 7);
    return 37 * 37 + (highResolution ? 3 : 4);
  }
  if (name.startsWith('gemini-')) {
    const major = Number(name.match(/^gemini-(\d+)/)?.[1] ?? 3);
    if (major < 3) return 5 * 258;
    return (
      { media_resolution_low: 280, media_resolution_medium: 560, media_resolution_ultra_high: 2240 }[level] ?? 1120
    );
  }
  return 520;
}
