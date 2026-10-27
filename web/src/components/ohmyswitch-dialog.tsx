import {
  Badge,
  Box,
  Button,
  createListCollection,
  Field,
  Group,
  HStack,
  IconButton,
  Link,
  Menu,
  NativeSelect,
  Portal,
  Select,
  Stack,
  Text,
} from '@chakra-ui/react';
import { Check, ChevronDown, Copy } from 'lucide-react';
import { useState } from 'react';

import { type AccessEndpoint, pickAccessEndpoint, storedAccessEndpointId } from '../lib/access-endpoints';
import {
  buildOhmyswitchUrl,
  buildOmsCommand,
  defaultOmsShell,
  type OhmyswitchProvider,
  type OhmyswitchVendor,
  type OmsCommand,
  type OmsShell,
  ohmyswitchEndpointsOf,
  ohmyswitchVendorLabels,
  ohmyswitchVendorOf,
  ohmyswitchVendors,
  omsShells,
} from '../lib/ohmyswitch';
import { brandColor } from '../lib/theme';
import { AccessEndpointField } from './access-endpoint-field';
import { type ExportKey, KeyExportDialog, keyExpired } from './key-export-dialog';
import { ErrorText, FormInput, PrimaryButton } from './ui';
import { VendorIcon } from './vendor-icon';

/** 下拉中的「跟随端点」。不是 ohmyswitch 的厂商，选中后不写入 vendor。 */
const followVendor = 'follow';

const vendorCollection = createListCollection({
  items: [
    { id: followVendor, name: '跟随端点' },
    ...ohmyswitchVendors.map((id) => ({ id, name: ohmyswitchVendorLabels[id] })),
  ],
  itemToValue: (item) => item.id,
  itemToString: (item) => item.name,
});

const commandErrors = {
  'unpassable-name': '供应商名称含有双引号或以反斜杠结尾，无法用于 PowerShell 命令，请修改名称',
  'too-long': '模型过多，命令超出了 Windows 命令行的长度上限，请改用导入链接',
} satisfies Record<Extract<OmsCommand, { error: string }>['error'], string>;

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
  const [vendor, setVendor] = useState<OhmyswitchVendor | ''>(
    ohmyswitchVendorOf(apiKey.models.map((model) => model.name)) ?? '',
  );
  const [submitted, setSubmitted] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [shell, setShell] = useState(defaultOmsShell);
  const shellLabel = omsShells.find((item) => item.id === shell)?.label;

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
      ...(vendor ? { vendor } : {}),
      models: apiKey.models.map((model) => model.name),
    };
  };
  const copyCommand = async (target: OmsShell) => {
    const provider = prepare();
    if (!provider) return;
    const result = buildOmsCommand(provider, target);
    if ('error' in result) {
      setActionError(commandErrors[result.error]);
      return;
    }
    try {
      await navigator.clipboard.writeText(result.command);
      setCopied(true);
    } catch {
      setActionError('复制失败，请检查浏览器剪贴板权限后重试');
    }
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
        <Field.Root>
          <Select.Root
            collection={vendorCollection}
            value={[vendor || followVendor]}
            positioning={{ sameWidth: true, strategy: 'fixed' }}
            onValueChange={(details) => {
              setVendor(ohmyswitchVendors.find((item) => item === details.value[0]) ?? '');
              edited();
            }}
          >
            <Select.HiddenSelect />
            <Select.Label>模型厂商</Select.Label>
            <Select.Control>
              <Select.Trigger>
                <Select.ValueText>
                  <HStack gap="2" minW="0">
                    {vendor && <VendorIcon vendor={vendor} />}
                    <Text truncate>{vendor ? ohmyswitchVendorLabels[vendor] : '跟随端点'}</Text>
                  </HStack>
                </Select.ValueText>
              </Select.Trigger>
              <Select.IndicatorGroup>
                <Select.Indicator />
              </Select.IndicatorGroup>
            </Select.Control>
            <Select.Positioner>
              <Select.Content maxH="min(320px, var(--available-height))" overflowY="auto">
                {vendorCollection.items.map((item) => {
                  const itemVendor = ohmyswitchVendors.find((vendor) => vendor === item.id);
                  return (
                    <Select.Item key={item.id} item={item}>
                      <HStack gap="2" minW="0" flex="1">
                        {itemVendor ? <VendorIcon vendor={itemVendor} /> : <Box boxSize="4" flexShrink="0" />}
                        <Text truncate>{item.name}</Text>
                      </HStack>
                      <Select.ItemIndicator />
                    </Select.Item>
                  );
                })}
              </Select.Content>
            </Select.Positioner>
          </Select.Root>
          <Field.HelperText color="gray.600">选定后，同一站点上厂商相同且端点有交集的供应商会被更新</Field.HelperText>
        </Field.Root>
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
          <Group attached>
            <Button
              type="button"
              variant="ghost"
              pe="2"
              disabled={refreshing}
              title={`复制 ${shellLabel} 的 oms 命令`}
              aria-label={copied ? `已复制 ${shellLabel} 的 oms 命令` : `复制 ${shellLabel} 的 oms 命令`}
              onClick={() => copyCommand(shell)}
            >
              {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
              复制 oms 命令
            </Button>
            <Menu.Root
              positioning={{ placement: 'bottom-end' }}
              onSelect={({ value }) => {
                const next = omsShells.find((item) => item.id === value);
                if (!next) return;
                setShell(next.id);
                copyCommand(next.id);
              }}
            >
              <Menu.Trigger asChild>
                <IconButton
                  type="button"
                  variant="ghost"
                  minW="8"
                  color="gray.600"
                  disabled={refreshing}
                  title="选择终端"
                  aria-label={`选择终端，当前为 ${shellLabel}`}
                >
                  <ChevronDown size={16} aria-hidden="true" />
                </IconButton>
              </Menu.Trigger>
              <Portal>
                <Menu.Positioner>
                  <Menu.Content minW="180px" borderRadius="xl">
                    <Menu.ItemGroup>
                      <Menu.ItemGroupLabel fontSize="xs" color="gray.500">
                        复制命令用于
                      </Menu.ItemGroupLabel>
                      {omsShells.map((item) => (
                        <Menu.Item key={item.id} value={item.id} borderRadius="lg">
                          {item.label}
                          {item.id === shell && (
                            <Check size={14} aria-label="当前" style={{ marginInlineStart: 'auto' }} />
                          )}
                        </Menu.Item>
                      ))}
                    </Menu.ItemGroup>
                  </Menu.Content>
                </Menu.Positioner>
              </Portal>
            </Menu.Root>
          </Group>
          <Link href="https://github.com/Wesley-Young/ohmyswitch" target="_blank" rel="noreferrer" color={brandColor}>
            了解 ohmyswitch
          </Link>
        </HStack>
      </Stack>
    </form>
  );
}
