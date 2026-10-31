import { Box, Button, Grid, Heading, HStack, Input, Link, Menu, Portal, Stack, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { Cpu, Ellipsis, Trash2 } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';

import { ModelIcon, ModelLabel } from '../components/brand-icon';
import { StatusDot } from '../components/channel-icon';
import { IconButton } from '../components/icon-button';
import { ModelForm } from '../components/model-form';
import { ModelImport } from '../components/model-import';
import { ModelPricing } from '../components/model-pricing';
import { ConfirmAction, ErrorText, Loading, Metric, PrimaryButton, Title } from '../components/ui';
import { refreshCatalog } from '../lib/cache';
import { compactCount, formatCount, formError } from '../lib/format';
import { filterModels, modelBrand, modelBrandLabel, sortModelsByBrand } from '../lib/model-brands';
import { brandColor } from '../lib/theme';
import { trpc, trpcClient } from '../lib/trpc';

export default function Models() {
  const { modelId } = useParams();
  const navigate = useNavigate();
  const catalog = useQuery(trpc.admin.catalog.list.queryOptions());
  const [edit, setEdit] = useState<{ id?: string }>();
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string>();
  const [search, setSearch] = useState('');
  const models = useMemo(() => sortModelsByBrand(catalog.data?.models ?? []), [catalog.data]);
  const visible = filterModels(models, { search, brand: '' });
  const selected = modelId ? models.find((model) => model.id === modelId) : (visible[0] ?? models[0]);

  return (
    <Stack gap="7">
      <Title
        action={
          <HStack flexWrap="wrap" gap="3">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setImportNotice(undefined);
                setImporting(true);
              }}
            >
              从 models.dev 导入
            </Button>
            <PrimaryButton size="sm" onClick={() => setEdit({})}>
              添加模型
            </PrimaryButton>
          </HStack>
        }
      >
        模型
      </Title>
      <ErrorText>{formError(catalog.error)?.message}</ErrorText>
      {importNotice && (
        <Text role="status" fontSize="sm" color="gray.600">
          {importNotice}
        </Text>
      )}
      {catalog.isPending ? (
        <Loading />
      ) : catalog.data ? (
        <Grid
          templateColumns={{ base: 'minmax(0, 1fr)', lg: '240px minmax(0, 1fr)' }}
          gap={{ base: '5', md: '7' }}
          alignItems="start"
        >
          <Box as="nav" aria-label="选择模型" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p="2" minW="0">
            {models.length > 0 && (
              <Input
                size="sm"
                type="search"
                aria-label="搜索模型"
                placeholder="搜索模型…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                mb="2"
              />
            )}
            {/* 定位上下文让行内的 srOnly 文本留在滚动区域内，不撑高页面。 */}
            <Stack gap="1" position="relative" maxH={{ base: '280px', lg: 'calc(100dvh - 300px)' }} overflowY="auto">
              {visible.map((model, index) => {
                const active = model.id === selected?.id;
                const brand = modelBrandLabel(model.name);
                const status = model.enabled ? '已启用' : '已禁用';
                return (
                  <Fragment key={model.id}>
                    {(index === 0 || modelBrandLabel(visible[index - 1].name) !== brand) && (
                      <Text px="3" pt={index === 0 ? '1' : '3'} pb="1" fontSize="xs" color="gray.500">
                        {brand}
                      </Text>
                    )}
                    <Link
                      asChild
                      display="flex"
                      alignItems="center"
                      gap="2.5"
                      px="3"
                      py="2"
                      borderRadius="lg"
                      fontSize="sm"
                      fontWeight={active ? '600' : '400'}
                      color={model.enabled ? 'gray.900' : 'gray.500'}
                      bg={active ? 'gray.100' : 'transparent'}
                      _hover={{ bg: active ? 'gray.100' : 'gray.50', textDecoration: 'none' }}
                      _focusVisible={{ outline: `2px solid ${brandColor}`, outlineOffset: '-2px' }}
                    >
                      <RouterLink
                        to={`/console/models/${model.id}/pricing`}
                        aria-current={active ? 'page' : undefined}
                        title={model.name}
                      >
                        <Box position="relative" display="flex" flexShrink="0" color="gray.400">
                          {modelBrand(model.name) ? (
                            <ModelIcon model={model.name} />
                          ) : (
                            <Cpu size={16} aria-hidden="true" />
                          )}
                          <Box position="absolute" right="-3px" bottom="-3px">
                            <StatusDot color={model.enabled ? 'green.500' : 'gray.300'} ring="white" />
                          </Box>
                        </Box>
                        <Text as="span" flex="1" minW="0" truncate>
                          {model.name}
                        </Text>
                        <Text as="span" srOnly>
                          ，{status}
                          {!model.priced && '，未定价'}
                        </Text>
                        {!model.priced && (
                          <Text
                            as="span"
                            flexShrink="0"
                            fontSize="xs"
                            fontWeight="500"
                            color="orange.600"
                            aria-hidden="true"
                          >
                            未定价
                          </Text>
                        )}
                      </RouterLink>
                    </Link>
                  </Fragment>
                );
              })}
              {!visible.length && (
                <Text p="3" fontSize="sm" color="gray.500">
                  {models.length ? '没有匹配的模型' : '暂无模型'}
                </Text>
              )}
            </Stack>
          </Box>
          <Box minW="0" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: '5', md: '6' }}>
            {selected ? (
              <Stack gap="5">
                <HStack justify="space-between" align="start" gap="4">
                  <Heading as="h2" fontSize="xl" overflowWrap="anywhere" minW="0">
                    <ModelLabel model={selected.name} size={20} />
                  </Heading>
                  <ModelActions
                    key={selected.id}
                    model={selected}
                    onEdit={() => setEdit({ id: selected.id })}
                    onDeleted={() => navigate('/console/models', { replace: true })}
                  />
                </HStack>
                <Grid templateColumns={{ base: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' }} gap="4">
                  <Metric label="状态">
                    <StatusDot color={selected.enabled ? 'green.500' : 'gray.300'} ring="transparent" />
                    {selected.enabled ? '已启用' : '已禁用'}
                  </Metric>
                  <Metric label="输入容量">
                    <Text as="span" title={`${formatCount(selected.inputTokenLimit)} Token`}>
                      {compactCount(selected.inputTokenLimit)} Token
                    </Text>
                  </Metric>
                  <Metric label="输出上限">
                    <Text as="span" title={`${formatCount(selected.outputTokenLimit)} Token`}>
                      {compactCount(selected.outputTokenLimit)} Token
                    </Text>
                  </Metric>
                  <Metric label="可用渠道">
                    {
                      catalog.data.channels.filter((channel) =>
                        channel.availableModels.some((model) => model.modelId === selected.id),
                      ).length
                    }{' '}
                    个
                  </Metric>
                </Grid>
                <Box borderTopWidth="1px" borderColor="gray.200" pt="5" mt="1">
                  <ModelPricing
                    key={selected.id}
                    modelId={selected.id}
                    copyLunaPrice={selected.name === 'codex-auto-review'}
                    lunaModelId={models.find((model) => model.name === 'gpt-5.6-luna' && model.priced)?.id}
                  />
                </Box>
              </Stack>
            ) : (
              <Text py="8" textAlign="center" color="gray.500" fontSize="sm">
                {!models.length ? '添加模型后配置定价规则' : '模型不存在，请在左侧选择模型'}
              </Text>
            )}
          </Box>
        </Grid>
      ) : null}
      {edit && (
        <ModelForm
          key={edit.id ?? 'new'}
          initial={models.find((model) => model.id === edit.id)}
          close={() => setEdit(undefined)}
          onSaved={(id) => navigate(`/console/models/${id}/pricing`)}
        />
      )}
      {importing && (
        <ModelImport
          existingModels={models}
          close={() => setImporting(false)}
          onImported={(result) => {
            setImportNotice(`已导入 ${result.imported.length} 个模型`);
            if (result.imported[0]) navigate(`/console/models/${result.imported[0].id}/pricing`);
          }}
        />
      )}
    </Stack>
  );
}

function ModelActions({
  model,
  onEdit,
  onDeleted,
}: {
  model: { id: string; name: string };
  onEdit: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  return (
    <HStack gap="1" flexShrink="0">
      <Button variant="outline" size="sm" onClick={onEdit}>
        编辑
      </Button>
      <Menu.Root positioning={{ placement: 'bottom-end' }} onSelect={() => setDeleting(true)}>
        <Menu.Trigger asChild>
          <IconButton
            aria-label={`「${model.name}」的更多操作`}
            title="更多操作"
            variant="ghost"
            size="sm"
            color="gray.600"
          >
            <Ellipsis size={16} aria-hidden="true" />
          </IconButton>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content minW="160px" borderRadius="xl">
              <Menu.Item value="delete" borderRadius="lg" color="red.600" _highlighted={{ bg: 'red.50' }}>
                <Trash2 size={14} aria-hidden="true" />
                删除模型
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      <ConfirmAction
        open={deleting}
        onClose={() => setDeleting(false)}
        label="删除模型"
        danger
        description={`删除模型「${model.name}」后，各渠道将无法再调用它。历史请求与账单仍然保留。`}
        action={() => trpcClient.admin.catalog.deleteModel.mutate({ modelId: model.id })}
        onSuccess={async () => {
          await refreshCatalog();
          onDeleted();
        }}
      />
    </HStack>
  );
}
