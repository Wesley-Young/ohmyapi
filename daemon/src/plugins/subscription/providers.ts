import type { Endpoint, SubscriptionProvider } from '../database/schema/index.ts';

/** 各订阅平台可转发的端点。 */
export const providerEndpoints = {
  openai: ['/v1/responses', '/v1/responses/compact'],
  claude: ['/v1/messages'],
} as const satisfies Record<SubscriptionProvider, readonly Endpoint[]>;

export function providerSupports(provider: string, endpoint: Endpoint) {
  return (
    provider in providerEndpoints &&
    (providerEndpoints[provider as SubscriptionProvider] as readonly Endpoint[]).includes(endpoint)
  );
}
