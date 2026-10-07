import { Badge, Box, Button, Grid, Heading, HStack, Link, Stack, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link as RouterLink, useNavigate, useParams } from 'react-router';

import { ModelImport } from '../components/model-import';
import { ConfirmAction, ErrorText, Loading, PrimaryButton, Title } from '../components/ui';
import { formError } from '../lib/format';
import { trpc, trpcClient } from '../lib/trpc';
import { ModelForm, refreshCatalog } from './Catalog';
import Pricing from './Pricing';

export default function Models() {
  const { modelId } = useParams();
  const navigate = useNavigate();
  const catalog = useQuery(trpc.admin.catalog.list.queryOptions());
  const [edit, setEdit] = useState<{ id?: string }>();
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<string>();
  const models = catalog.data?.models ?? [];
  const selected = modelId ? models.find((model) => model.id === modelId) : models[0];

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
            <Stack gap="1" maxH={{ base: '280px', lg: 'calc(100dvh - 240px)' }} overflowY="auto">
              {models.map((model) => {
                const active = model.id === selected?.id;
                return (
                  <Link
                    key={model.id}
                    asChild
                    display="block"
                    p="3"
                    borderRadius="lg"
                    color="gray.900"
                    bg={active ? 'gray.100' : 'transparent'}
                    _hover={{ bg: 'gray.50', textDecoration: 'none' }}
                    _focusVisible={{ outline: '2px solid #635bff', outlineOffset: '-2px' }}
                  >
                    <RouterLink to={`/console/models/${model.id}/pricing`} aria-current={active ? 'page' : undefined}>
                      <Stack gap="2">
                        <Text fontSize="sm" fontWeight={active ? '600' : '500'} overflowWrap="anywhere">
                          {model.name}
                        </Text>
                        <HStack gap="2" flexWrap="wrap">
                          <Badge colorPalette={model.enabled ? 'green' : 'gray'}>
                            {model.enabled ? '启用' : '禁用'}
                          </Badge>
                          <Badge colorPalette="gray">{model.priced ? '已定价' : '未定价'}</Badge>
                        </HStack>
                      </Stack>
                    </RouterLink>
                  </Link>
                );
              })}
              {!models.length && (
                <Text p="3" fontSize="sm" color="gray.500">
                  暂无模型
                </Text>
              )}
            </Stack>
          </Box>
          <Box minW="0" borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: '5', md: '6' }}>
            {selected ? (
              <Stack gap="6">
                <HStack justify="space-between" align="start" flexWrap="wrap" gap="4">
                  <Stack gap="3" minW="0">
                    <Heading as="h2" fontSize="xl" overflowWrap="anywhere">
                      {selected.name}
                    </Heading>
                    <HStack gap="2" flexWrap="wrap">
                      <Badge colorPalette="gray">输入容量 {selected.inputTokenLimit.toLocaleString()} Token</Badge>
                      <Badge colorPalette="gray">输出上限 {selected.outputTokenLimit.toLocaleString()} Token</Badge>
                    </HStack>
                  </Stack>
                  <HStack gap="2" flexWrap="wrap">
                    <Button variant="outline" size="sm" onClick={() => setEdit({ id: selected.id })}>
                      编辑模型元数据
                    </Button>
                    <ConfirmAction
                      key={selected.id}
                      label="删除模型"
                      danger
                      description={`删除模型「${selected.name}」后，各渠道将无法再调用它。历史请求与账单仍然保留。`}
                      action={() => trpcClient.admin.catalog.deleteModel.mutate({ modelId: selected.id })}
                      onSuccess={async () => {
                        await refreshCatalog();
                        navigate('/console/models', { replace: true });
                      }}
                    />
                  </HStack>
                </HStack>
                <Pricing key={selected.id} modelId={selected.id} />
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
          existingNames={models.map((model) => model.name)}
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
