import { Button, Field, HStack, NativeSelect, Stack } from '@chakra-ui/react';
import type { RouterOutputs } from '@ohmyapi/daemon/trpc';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { buildCCSwitchUrl, type CCSwitchModels, ccSwitchApps, ccSwitchModelFields } from '../lib/cc-switch';
import { formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { ErrorText, FormDialog, FormInput, Loading, PrimaryButton } from './ui';

type ExportKey = RouterOutputs['keys']['playgroundOptions'][number];

export function CCSwitchDialog({ keyId, onClose }: { keyId: string; onClose: () => void }) {
  const options = useQuery(trpc.keys.playgroundOptions.queryOptions(undefined, { staleTime: 0, gcTime: 0 }));
  const selectedKey = options.data?.find((key) => key.id === keyId);
  return (
    <FormDialog open title="导出到 CC Switch" onClose={onClose}>
      {options.isPending || !options.isFetchedAfterMount ? (
        <Loading />
      ) : options.error ? (
        <Stack gap="4">
          <ErrorText>{formError(options.error)?.message}</ErrorText>
          <Button variant="outline" alignSelf="start" loading={options.isFetching} onClick={() => options.refetch()}>
            重试
          </Button>
        </Stack>
      ) : !selectedKey ? (
        <ErrorText>此 Key 已失效，或渠道没有已授权且已定价的可用模型。</ErrorText>
      ) : !ccSwitchApps.some((app) => selectedKey.endpoints.includes(app.endpoint)) ? (
        <ErrorText>此 Key 的渠道未支持 Claude Code 或 Codex 所需的端点。</ErrorText>
      ) : (
        <ExportForm key={selectedKey.id} apiKey={selectedKey} refreshing={options.isFetching} onClose={onClose} />
      )}
    </FormDialog>
  );
}

function ExportForm({ apiKey, refreshing, onClose }: { apiKey: ExportKey; refreshing: boolean; onClose: () => void }) {
  const applications = ccSwitchApps.filter((app) => apiKey.endpoints.includes(app.endpoint));
  const [appId, setAppId] = useState(applications[0].id);
  const app = applications.find((item) => item.id === appId) ?? applications[0];
  const [name, setName] = useState(`ohmyapi - ${apiKey.name}`);
  const [models, setModels] = useState<CCSwitchModels>({});
  const [submitted, setSubmitted] = useState(false);
  const [launchError, setLaunchError] = useState<string>();
  const fields = ccSwitchModelFields(app.id);
  const modelError = (field: (typeof fields)[number]) => {
    const value = models[field.key];
    if (!value) return field.required ? '请选择主模型' : undefined;
    if (!apiKey.models.some((model) => model.name === value)) return '此模型已不可用，请重新选择';
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        setLaunchError(undefined);
        if (refreshing || !name.trim() || fields.some((field) => modelError(field))) return;
        if (apiKey.expiresAt && new Date(apiKey.expiresAt).getTime() <= Date.now()) {
          setLaunchError('此 Key 已过期，请选择其他 Key');
          return;
        }
        try {
          window.location.assign(
            buildCCSwitchUrl({ app: app.id, name, origin: window.location.origin, apiKey: apiKey.token, models }),
          );
        } catch {
          setLaunchError('无法打开 CC Switch，请确认已安装并允许浏览器打开');
        }
      }}
    >
      <Stack gap="5">
        <Field.Root>
          <Field.Label>应用</Field.Label>
          <NativeSelect.Root>
            <NativeSelect.Field
              value={app.id}
              onChange={(event) => {
                const nextApp = applications.find((item) => item.id === event.target.value);
                if (!nextApp) return;
                setAppId(nextApp.id);
                setModels({});
                setSubmitted(false);
                setLaunchError(undefined);
              }}
            >
              {applications.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </NativeSelect.Field>
            <NativeSelect.Indicator />
          </NativeSelect.Root>
        </Field.Root>
        <FormInput
          label="配置名称"
          value={name}
          required
          maxLength={128}
          error={submitted && !name.trim() ? '请填写配置名称' : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        {fields.map((field) => {
          const error = modelError(field);
          return (
            <Field.Root key={field.key} required={field.required} invalid={submitted && Boolean(error)}>
              <Field.Label>
                {field.label}
                {field.required && <Field.RequiredIndicator />}
              </Field.Label>
              <NativeSelect.Root>
                <NativeSelect.Field
                  value={models[field.key] ?? ''}
                  onChange={(event) => setModels({ ...models, [field.key]: event.target.value })}
                >
                  <option value="">{field.required ? '选择模型' : '不指定'}</option>
                  {apiKey.models.map((model) => (
                    <option key={model.id} value={model.name}>
                      {model.name}
                    </option>
                  ))}
                </NativeSelect.Field>
                <NativeSelect.Indicator />
              </NativeSelect.Root>
              {submitted && error && <Field.ErrorText>{error}</Field.ErrorText>}
            </Field.Root>
          );
        })}
        <ErrorText>{launchError}</ErrorText>
        <HStack gap="3" flexWrap="wrap">
          <PrimaryButton type="submit" disabled={refreshing}>
            打开 CC Switch
          </PrimaryButton>
          <Button type="button" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </HStack>
      </Stack>
    </form>
  );
}
