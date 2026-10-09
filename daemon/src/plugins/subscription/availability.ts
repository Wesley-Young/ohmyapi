import { sql } from 'drizzle-orm';

import { channels, subscriptionAccounts } from '../database/schema/index.js';

export function availableSubscription() {
  return sql`(${channels.type} <> 'subscription' or exists (
    select 1 from ${subscriptionAccounts}
    where ${subscriptionAccounts.id} = ${channels.subscriptionAccountId}
      and ${subscriptionAccounts.enabled} = true
      and ${subscriptionAccounts.deletedAt} is null
      and ${subscriptionAccounts.errorCode} is null
  ))`;
}
