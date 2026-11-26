import { familyEndpoints } from '@ohmyapi/protocols';

import { channelEndpointFor, type Endpoint, type SubscriptionProvider } from '../database/schema/index.ts';

/** 各订阅平台支持的协议主端点。 */
export const providerEndpoints = {
  openai: familyEndpoints.responses,
  claude: familyEndpoints.messages,
  antigravity: familyEndpoints.gemini,
} satisfies Record<SubscriptionProvider, Endpoint>;

export function providerSupports(provider: SubscriptionProvider, endpoint: Endpoint) {
  return providerEndpoints[provider] === channelEndpointFor(endpoint);
}
