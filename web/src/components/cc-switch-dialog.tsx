import { Field, HStack, NativeSelect, Stack } from '@chakra-ui/react';
import { useState } from 'react';

import { type AccessEndpoint, pickAccessEndpoint, storedAccessEndpointId } from '../lib/access-endpoints';
import {
  buildCCSwitchUrl,
  type CCSwitchModels,
  ccSwitchApps,
  ccSwitchModelFields,
  supportsCCSwitch,
} from '../lib/cc-switch';
import { AccessEndpointField } from './access-endpoint-field';
import { type ExportKey, KeyExportDialog, keyExpired } from './key-export-dialog';
import { ErrorText, FormInput, PrimaryButton } from './ui';

export function CCSwitchDialog({ keyId, onClose }: { keyId: string; onClose: () => void }) {
  return (
    <KeyExportDialog
      keyId={keyId}
      title="导出到 CC Switch"
      unsupported={(key) =>
        supportsCCSwitch(key.endpoints) ? undefined : '此 Key 的渠道未提供 CC Switch 配置所需的 Responses 端点。'
      }
      onClose={onClose}
    >
      {(props) => <ExportForm key={props.apiKey.id} {...props} />}
    </KeyExportDialog>
  );
}

function ExportForm({
  apiKey,
  accessEndpoints,
  refreshing,
}: {
  apiKey: ExportKey;
  accessEndpoints: AccessEndpoint[];
  refreshing: boolean;
}) {
  const [accessEndpointId, setAccessEndpointId] = useState(storedAccessEndpointId);
  const accessEndpoint = pickAccessEndpoint(accessEndpoints, accessEndpointId);
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
        if (keyExpired(apiKey)) {
          setLaunchError('此 Key 已过期，请选择其他 Key');
          return;
        }
        try {
          window.location.assign(
            buildCCSwitchUrl({
              app: app.id,
              name,
              baseUrl: accessEndpoint.baseUrl,
              homepage: window.location.origin,
              apiKey: apiKey.token,
              models,
            }),
          );
        } catch {
          setLaunchError('无法打开 CC Switch，请确认已安装并允许浏览器打开');
        }
      }}
    >
      <Stack gap="5">
        <Field.Root>
          <Field.Label>配置类型</Field.Label>
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
        <AccessEndpointField options={accessEndpoints} value={accessEndpoint} onChange={setAccessEndpointId} />
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
            导入 CC Switch
          </PrimaryButton>
        </HStack>
      </Stack>
    </form>
  );
}
