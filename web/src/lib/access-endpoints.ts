import type { RouterOutputs } from '@ohmyapi/daemon/trpc';

export type AccessEndpoint = RouterOutputs['keys']['accessEndpoints'][number];

const storageKey = 'ohmyapi.accessEndpoint';

/** 可选的接入点；部署者未配置时只有当前站点。 */
export function accessEndpointOptions(configured: AccessEndpoint[] | undefined): AccessEndpoint[] {
  if (configured?.length) return configured;
  return [{ id: 'current', label: '本站', baseUrl: window.location.origin, description: null }];
}

/** 用户上次选择的接入点 ID。 */
export function storedAccessEndpointId() {
  try {
    return localStorage.getItem(storageKey) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeAccessEndpointId(id: string) {
  try {
    localStorage.setItem(storageKey, id);
  } catch {
    // 无法写入时只影响下次的默认选项。
  }
}

/** 按 ID 选取接入点，找不到时使用第一项。 */
export function pickAccessEndpoint(options: AccessEndpoint[], id: string | undefined) {
  return options.find((option) => option.id === id) ?? options[0];
}
