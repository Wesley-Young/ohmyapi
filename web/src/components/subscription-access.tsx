import { Button, Field, Link, Stack, Text, Textarea } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { RefreshCw } from 'lucide-react';

import { formError, localDateTime } from '../lib/format';
import { type SubscriptionProvider, subscriptionAccessHints, subscriptionProviderLabels } from '../lib/subscription';
import { brandColor } from '../lib/theme';
import { ProviderIcon } from './brand-icon';
import { OpenAIResetCredits } from './openai-reset-credits';
import { ErrorText, FormInput } from './ui';
import { ViewSwitch } from './view-switch';

type Channel = RouterOutputs['admin']['catalog']['list']['channels'][number];
export type SubscriptionAccessMode = 'oauth' | 'import';

const accessModes = [
  { value: 'oauth', label: 'OAuth 授权' },
  { value: 'import', label: '导入凭据' },
] as const satisfies readonly { value: SubscriptionAccessMode; label: string }[];

/** 已接入订阅账号的令牌状态、手动刷新与重置卡。 */
export function SubscriptionAccount({
  channel,
  subscription,
  refreshing,
  refreshError,
  onRefresh,
  onResetCreditBusyChange,
}: {
  channel: Channel;
  subscription: NonNullable<Channel['subscription']>;
  refreshing: boolean;
  refreshError: unknown;
  onRefresh: () => void;
  onResetCreditBusyChange: (busy: boolean) => void;
}) {
  return (
    <Stack gap="3">
      <Text fontSize="sm" color="gray.500">
        访问令牌有效期至 {localDateTime(subscription.expiresAt)}，到期前将自动刷新
      </Text>
      <Button
        type="button"
        variant="outline"
        size="sm"
        alignSelf="start"
        disabled={!channel.enabled}
        loading={refreshing}
        onClick={onRefresh}
      >
        <RefreshCw size={16} aria-hidden="true" />
        手动刷新令牌
      </Button>
      <ErrorText>{formError(refreshError)?.message}</ErrorText>
      {subscription.provider === 'openai' && (
        <OpenAIResetCredits
          channelId={channel.id}
          channelName={channel.name}
          enabled={channel.enabled && !subscription.errorCode}
          onBusyChange={onResetCreditBusyChange}
        />
      )}
    </Stack>
  );
}

/** 订阅账号的接入方式：OAuth 授权回调或导入凭据。 */
export function SubscriptionAccess({
  provider,
  editing,
  busy,
  mode,
  onModeChange,
  credentials,
  onCredentialsChange,
  callback,
  onCallbackChange,
  oauthUrl,
  oauthPending,
  onStartOAuth,
}: {
  provider: SubscriptionProvider;
  editing: boolean;
  busy: boolean;
  mode: SubscriptionAccessMode;
  onModeChange: (mode: SubscriptionAccessMode) => void;
  credentials: string;
  onCredentialsChange: (value: string) => void;
  callback: string;
  onCallbackChange: (value: string) => void;
  oauthUrl?: string;
  oauthPending: boolean;
  onStartOAuth: () => void;
}) {
  return (
    <>
      <Field.Root>
        <Field.Label>接入方式</Field.Label>
        <ViewSwitch label="接入方式" items={accessModes} value={mode} disabled={busy} onChange={onModeChange} />
      </Field.Root>
      {mode === 'import' ? (
        <Field.Root>
          <Field.Label>{editing ? '替换凭据（留空保留现有凭据）' : '账号凭据'}</Field.Label>
          <Textarea
            aria-label="账号凭据"
            value={credentials}
            onChange={(e) => onCredentialsChange(e.target.value)}
            rows={7}
            maxLength={60000}
            required={!editing}
            autoComplete="off"
            spellCheck={false}
          />
          <Field.HelperText>{subscriptionAccessHints[provider].credentials}</Field.HelperText>
        </Field.Root>
      ) : (
        <Stack gap="3">
          <Button type="button" variant="outline" onClick={onStartOAuth} loading={oauthPending} disabled={busy}>
            <ProviderIcon provider={provider} />
            生成授权链接
          </Button>
          {oauthUrl && (
            <>
              <Link href={oauthUrl} target="_blank" rel="noreferrer" color={brandColor}>
                打开 {subscriptionProviderLabels[provider]} 授权页面
              </Link>
              <Text fontSize="sm" color="gray.500">
                授权后将跳转到 {subscriptionAccessHints[provider].callback}
                ，即使页面提示无法访问，也请复制地址栏的完整 URL 并粘贴到下方。
              </Text>
            </>
          )}
          <FormInput
            label={editing ? '授权回调地址（留空保留现有凭据）' : '授权回调地址'}
            value={callback}
            onChange={(e) => onCallbackChange(e.target.value)}
            type="url"
            required={!editing || Boolean(oauthUrl)}
            autoComplete="off"
            maxLength={8192}
            spellCheck={false}
          />
        </Stack>
      )}
    </>
  );
}
