import { Badge, Button, HStack, Link, Stack, Text } from '@chakra-ui/react';
import { useState } from 'react';

import { type AccessEndpoint, pickAccessEndpoint, storedAccessEndpointId } from '../lib/access-endpoints';
import { buildOhmyswitchUrl, ohmyswitchEndpointsOf } from '../lib/ohmyswitch';
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
      {(props) => <ExportForm key={props.apiKey.id} {...props} onClose={onClose} />}
    </KeyExportDialog>
  );
}

function ExportForm({
  apiKey,
  accessEndpoints,
  refreshing,
  onClose,
}: {
  apiKey: ExportKey;
  accessEndpoints: AccessEndpoint[];
  refreshing: boolean;
  onClose: () => void;
}) {
  const [accessEndpointId, setAccessEndpointId] = useState(storedAccessEndpointId);
  const accessEndpoint = pickAccessEndpoint(accessEndpoints, accessEndpointId);
  const [name, setName] = useState(`ohmyapi - ${apiKey.name}`);
  const [submitted, setSubmitted] = useState(false);
  const [launchError, setLaunchError] = useState<string>();
  const endpoints = ohmyswitchEndpointsOf(apiKey.endpoints);

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        setLaunchError(undefined);
        if (refreshing || !name.trim()) return;
        if (keyExpired(apiKey)) {
          setLaunchError('此 Key 已过期，请选择其他 Key');
          return;
        }
        const url = buildOhmyswitchUrl({
          name,
          baseUrl: accessEndpoint.baseUrl,
          endpoints,
          apiKey: apiKey.token,
          iconUrl: window.location.origin,
          models: apiKey.models.map((model) => model.name),
        });
        if (!url) {
          setLaunchError('模型过多，超出了 ohmyswitch 导入链接的长度上限');
          return;
        }
        try {
          window.location.assign(url);
        } catch {
          setLaunchError('无法打开 ohmyswitch，请确认已安装并允许浏览器打开');
        }
      }}
    >
      <Stack gap="5">
        <AccessEndpointField options={accessEndpoints} value={accessEndpoint} onChange={setAccessEndpointId} />
        <FormInput
          label="供应商名称"
          value={name}
          required
          maxLength={128}
          error={submitted && !name.trim() ? '请填写供应商名称' : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        <Stack as="dl" gap="3" fontSize="sm">
          <Stack gap="1.5">
            <Text as="dt" fontWeight="500">
              端点
            </Text>
            <Stack as="dd" gap="1">
              {endpoints.map((endpoint) => (
                <Text key={endpoint} fontFamily="mono" color="gray.700" overflowWrap="anywhere">
                  {endpoint}
                </Text>
              ))}
            </Stack>
          </Stack>
          <Stack gap="1.5">
            <Text as="dt" fontWeight="500">
              模型
            </Text>
            <HStack as="dd" gap="2" flexWrap="wrap" maxH="40" overflowY="auto">
              {apiKey.models.map((model) => (
                <Badge key={model.id} colorPalette="gray" maxW="full" whiteSpace="normal" overflowWrap="anywhere">
                  {model.name}
                </Badge>
              ))}
            </HStack>
          </Stack>
        </Stack>
        <ErrorText>{launchError}</ErrorText>
        <Stack gap="3">
          <HStack gap="3" flexWrap="wrap">
            <PrimaryButton type="submit" disabled={refreshing}>
              导入到 ohmyswitch
            </PrimaryButton>
            <Button type="button" variant="ghost" onClick={onClose}>
              关闭
            </Button>
            <Link href="https://github.com/Wesley-Young/ohmyswitch" target="_blank" rel="noreferrer" color={brandColor}>
              了解 ohmyswitch
            </Link>
          </HStack>
        </Stack>
      </Stack>
    </form>
  );
}
