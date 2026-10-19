import { Badge, Button, Field, HStack, Link, NativeSelect, Stack, Text } from '@chakra-ui/react';
import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { type AccessEndpoint, pickAccessEndpoint, storedAccessEndpointId } from '../lib/access-endpoints';
import { buildOhmyswitchUrl, buildOmsCommand, type OhmyswitchProvider, ohmyswitchEndpointsOf } from '../lib/ohmyswitch';
import { brandColor } from '../lib/theme';
import { AccessEndpointField } from './access-endpoint-field';
import { type ExportKey, KeyExportDialog, keyExpired } from './key-export-dialog';
import { ErrorText, FormInput, PrimaryButton } from './ui';

export function OhmyswitchDialog({ keyId, onClose }: { keyId: string; onClose: () => void }) {
  return (
    <KeyExportDialog
      keyId={keyId}
      title="导出到 ohmyswitch"
      unsupported={(key) =>
        ohmyswitchEndpointsOf(key.endpoints).length ? undefined : '此 Key 的渠道未提供 ohmyswitch 支持的端点。'
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
  const [name, setName] = useState(`ohmyapi - ${apiKey.name}`);
  const endpoints = ohmyswitchEndpointsOf(apiKey.endpoints);
  const [selectedEndpoint, setSelectedEndpoint] = useState(endpoints[0]);
  const endpoint = endpoints.find((item) => item === selectedEndpoint) ?? endpoints[0];
  const [submitted, setSubmitted] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [copied, setCopied] = useState(false);

  /** 校验表单；可以导出时返回要导出的供应商。 */
  const prepare = (): OhmyswitchProvider | undefined => {
    setSubmitted(true);
    setActionError(undefined);
    setCopied(false);
    if (refreshing || !name.trim()) return;
    if (keyExpired(apiKey)) {
      setActionError('此 Key 已过期，请选择其他 Key');
      return;
    }
    return {
      name,
      baseUrl: accessEndpoint.baseUrl,
      endpoint,
      endpoints,
      apiKey: apiKey.token,
      iconUrl: window.location.origin,
      models: apiKey.models.map((model) => model.name),
    };
  };
  const edited = () => {
    setCopied(false);
    setActionError(undefined);
  };

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        const provider = prepare();
        if (!provider) return;
        const url = buildOhmyswitchUrl(provider);
        if (!url) {
          setActionError('模型过多，超出了 ohmyswitch 导入链接的长度上限，请改用 oms 命令导入');
          return;
        }
        try {
          window.location.assign(url);
        } catch {
          setActionError('无法打开 ohmyswitch，请确认已安装并允许浏览器打开');
        }
      }}
    >
      <Stack gap="5">
        <AccessEndpointField
          options={accessEndpoints}
          value={accessEndpoint}
          onChange={(id) => {
            setAccessEndpointId(id);
            edited();
          }}
        />
        <FormInput
          label="供应商名称"
          value={name}
          required
          maxLength={128}
          error={submitted && !name.trim() ? '请填写供应商名称' : undefined}
          onChange={(event) => {
            setName(event.target.value);
            edited();
          }}
        />
        {endpoints.length > 1 ? (
          <Field.Root>
            <Field.Label>端点</Field.Label>
            <NativeSelect.Root>
              <NativeSelect.Field
                fontFamily="mono"
                value={endpoint}
                onChange={(event) => {
                  const next = endpoints.find((item) => item === event.target.value);
                  if (!next) return;
                  setSelectedEndpoint(next);
                  edited();
                }}
              >
                {endpoints.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </NativeSelect.Field>
              <NativeSelect.Indicator />
            </NativeSelect.Root>
          </Field.Root>
        ) : (
          <Stack gap="1.5" fontSize="sm">
            <Text fontWeight="500">端点</Text>
            <Text fontFamily="mono" color="gray.700" overflowWrap="anywhere">
              {endpoint}
            </Text>
          </Stack>
        )}
        <Stack gap="1.5" fontSize="sm">
          <Text fontWeight="500">模型</Text>
          <HStack gap="2" flexWrap="wrap" maxH="40" overflowY="auto">
            {apiKey.models.map((model) => (
              <Badge key={model.id} colorPalette="gray" maxW="full" whiteSpace="normal" overflowWrap="anywhere">
                {model.name}
              </Badge>
            ))}
          </HStack>
        </Stack>
        <ErrorText>{actionError}</ErrorText>
        <HStack gap="3" flexWrap="wrap">
          <PrimaryButton type="submit" disabled={refreshing}>
            导入到 ohmyswitch
          </PrimaryButton>
          <Button
            type="button"
            variant="ghost"
            disabled={refreshing}
            aria-label={copied ? '已复制 oms 命令' : '复制 oms 命令'}
            onClick={async () => {
              const provider = prepare();
              if (!provider) return;
              try {
                await navigator.clipboard.writeText(buildOmsCommand(provider));
                setCopied(true);
              } catch {
                setActionError('复制失败，请检查浏览器剪贴板权限后重试');
              }
            }}
          >
            {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
            复制 oms 命令
          </Button>
          <Link href="https://github.com/Wesley-Young/ohmyswitch" target="_blank" rel="noreferrer" color={brandColor}>
            了解 ohmyswitch
          </Link>
        </HStack>
      </Stack>
    </form>
  );
}
