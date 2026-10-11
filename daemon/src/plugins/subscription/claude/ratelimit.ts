// 对齐 CPA helps/claude_ratelimit.go：只使用被拒绝窗口的 reset，共享额度取最晚恢复时间。
export function claudeRateLimit(headers: Headers, status: number, errorBody = '') {
  const get = (suffix: string) => headers.get(`anthropic-ratelimit-unified-${suffix}`)?.trim().toLowerCase();
  const shared = get('5h-status') === 'rejected' || get('7d-status') === 'rejected';
  const healthy = (window: string) =>
    ['allowed', 'allowed_warning'].includes(get(`${window}-status`) ?? '') ||
    (!get(`${window}-status`) &&
      Boolean(get(`${window}-utilization`)) &&
      Number(get(`${window}-utilization`)) >= 0 &&
      Number(get(`${window}-utilization`)) < 1);
  const overage =
    get('7d_oi-status') === 'rejected' ||
    get('overage-status') === 'rejected' ||
    !!get('overage-disabled-reason') ||
    !!get('representative-claim')?.includes('overage');
  const overageOnly = !shared && overage && healthy('5h') && healthy('7d');
  const modelOnly = !(shared || (get('status') === 'rejected' && !overageOnly));
  const error = errorBody.toLowerCase();
  if (
    modelOnly &&
    (error.includes('fast request rejected') ||
      (error.includes('fast') && (error.includes('usage credits') || error.includes('credits are required'))))
  )
    return;
  if (status !== 429 && !shared && get('status') !== 'rejected') return;
  const now = Date.now();
  const deadlines: number[] = [];
  const reset = (value: string | null | undefined, relative = false) => {
    if (!value) return;
    const numeric = Number(value);
    const date = Number.isFinite(numeric) ? (relative ? now : 0) + numeric * 1000 : Date.parse(value);
    if (Number.isFinite(date) && date > now) deadlines.push(date);
  };
  if (!overageOnly) {
    reset(headers.get('retry-after'), true);
    for (const window of ['5h', '7d', '7d_oi'])
      if (get(`${window}-status`) === 'rejected') reset(get(`${window}-reset`));
    if (shared || get('status') === 'rejected' || (!get('status') && !healthy('5h') && !healthy('7d')))
      reset(get('reset'));
  }
  return {
    modelOnly,
    until: new Date(
      (deadlines.length ? Math.max(...deadlines) : now + 60_000) + (1 + Math.floor(Math.random() * 30)) * 1000,
    ),
  };
}
