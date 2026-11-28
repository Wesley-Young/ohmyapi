import { type FamilyEndpoint, familyEndpoints } from '@ohmyapi/protocols';

import { channelEndpointFor, type Endpoint, type SubscriptionProvider } from '../database/schema/index.ts';

/** 各订阅平台支持的协议主端点。 */
export const providerEndpoints: Record<SubscriptionProvider, FamilyEndpoint[]> = {
  openai: [familyEndpoints.responses],
  claude: [familyEndpoints.messages],
  antigravity: [familyEndpoints.gemini],
  zhipu: [familyEndpoints.responses, familyEndpoints.chat, familyEndpoints.messages],
};

export function providerSupports(provider: SubscriptionProvider, endpoint: Endpoint) {
  const family = channelEndpointFor(endpoint);
  return (provider !== 'zhipu' || endpoint === family) && providerEndpoints[provider].includes(family);
}
