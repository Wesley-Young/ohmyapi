import { Box, Button, Dialog, Grid, HStack, Portal, RadioCard, Steps, Switch, Tabs, Text } from '@chakra-ui/react';
import { Check, ChevronDown, Globe, Lock, X } from 'lucide-react';
import { type ReactNode, type SyntheticEvent, useId, useState } from 'react';

import { brandColor } from '../lib/theme';
import { IconButton } from './icon-button';
import { ErrorText, FormInput, PrimaryButton } from './ui';

const configurationSections = [
  { value: 'access', label: '接入配置' },
  { value: 'models', label: '模型与计费' },
  { value: 'policy', label: '运行与访问' },
] as const;

export function ChannelDisclosure({
  title,
  summary,
  children,
  defaultOpen,
}: {
  title: ReactNode;
  summary?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <Box
      asChild
      borderTopWidth="1px"
      borderColor="gray.200"
      minW="0"
      css={{
        '& > summary::-webkit-details-marker': { display: 'none' },
        '&[open] > summary > svg': { transform: 'rotate(180deg)' },
      }}
    >
      <details open={defaultOpen}>
        <HStack
          as="summary"
          minH="11"
          py="2"
          gap="2"
          cursor="pointer"
          fontSize="sm"
          fontWeight="500"
          listStyleType="none"
        >
          <Box minW="0" flex="1" overflowWrap="anywhere">
            {title}
          </Box>
          {summary && (
            <Text as="span" fontWeight="400" fontSize="xs" color="gray.600" textAlign="end">
              {summary}
            </Text>
          )}
          <ChevronDown size={15} aria-hidden="true" style={{ flexShrink: 0 }} />
        </HStack>
        <Box pb="3">{children}</Box>
      </details>
    </Box>
  );
}

export function ChannelMultiplierField({
  value,
  onChange,
  overall = false,
}: {
  value: string;
  onChange: (value: string) => void;
  overall?: boolean;
}) {
  const amount = Number(value);
  const error =
    value && (!/^-?(0|[1-9]\d*)(\.\d{1,6})?$/.test(value) || amount < 0 || amount > 1000)
      ? '请输入 0–1000 之间的倍率，最多六位小数'
      : undefined;
  return (
    <FormInput
      label={overall ? '整体扣费倍率' : '专属倍率'}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode="decimal"
      required={overall}
      maxLength={30}
      placeholder={overall ? undefined : '继承整体倍率'}
      helper={overall ? '0–1000，最多六位小数。模型专属倍率优先。' : undefined}
      error={error}
      data-channel-error={error}
    />
  );
}

export function ChannelVisibility({
  isPublic,
  onChange,
  disabled,
}: {
  isPublic: boolean;
  onChange: (value: boolean) => void;
  disabled: boolean;
}) {
  return (
    <RadioCard.Root
      value={isPublic ? 'public' : 'private'}
      onValueChange={({ value }) => onChange(value === 'public')}
      disabled={disabled}
      size="sm"
      variant="outline"
      colorPalette="purple"
    >
      <RadioCard.Label>访问权限</RadioCard.Label>
      <Grid templateColumns={{ base: 'minmax(0, 1fr)', sm: 'repeat(2, minmax(0, 1fr))' }} gap="2">
        {[
          { value: 'public', label: '公开渠道', hint: '所有用户均可使用', Icon: Globe },
          { value: 'private', label: '非公开渠道', hint: '仅管理员授权的用户可用', Icon: Lock },
        ].map(({ value, label, hint, Icon }) => (
          <RadioCard.Item key={value} value={value} borderRadius="lg">
            <RadioCard.ItemHiddenInput />
            <RadioCard.ItemControl gap="2" alignItems="start" p="3">
              <Icon size={16} aria-hidden="true" />
              <RadioCard.ItemContent>
                <RadioCard.ItemText>{label}</RadioCard.ItemText>
                <RadioCard.ItemDescription>{hint}</RadioCard.ItemDescription>
              </RadioCard.ItemContent>
              <RadioCard.ItemIndicator />
            </RadioCard.ItemControl>
          </RadioCard.Item>
        ))}
      </Grid>
    </RadioCard.Root>
  );
}

export function ChannelDialog({
  creating,
  enabled,
  onEnabledChange,
  busy,
  saving,
  close,
  onSave,
  error,
  panels,
}: {
  creating: boolean;
  enabled: boolean;
  onEnabledChange: (value: boolean) => void;
  busy: boolean;
  saving: boolean;
  close: () => void;
  onSave: () => void;
  error?: string;
  panels: Record<(typeof configurationSections)[number]['value'], ReactNode> & { maintenance?: ReactNode };
}) {
  const sections =
    !creating && panels.maintenance
      ? [...configurationSections, { value: 'maintenance', label: '账号维护' } as const]
      : configurationSections;
  const formId = useId();
  const [step, setStep] = useState(0);
  const section = sections[step];
  const hasNext = creating && step < sections.length - 1;
  const [validation, setValidation] = useState<string>();
  function changeStep(index: number) {
    setStep(index);
    setValidation(undefined);
    if (creating)
      requestAnimationFrame(() => {
        const panel = document
          .getElementById(formId)
          ?.querySelector<HTMLElement>(`[data-section="${sections[index].value}"]`);
        panel?.focus();
      });
  }

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    // 前两步校验当前分区，保存前再次检查全部字段，包括折叠的模型和审计设置。
    const scope = hasNext ? form.querySelector(`[data-section="${section.value}"]`) : form;
    const invalid = scope?.querySelector<HTMLElement>(
      'input:invalid, textarea:invalid, select:invalid, [data-channel-error]',
    );
    if (invalid) {
      const panel = invalid.closest<HTMLElement>('[data-section]');
      const index = sections.findIndex((item) => item.value === panel?.dataset.section);
      if (index >= 0) setStep(index);
      setValidation(invalid.dataset.channelError);
      for (let detail = invalid.closest('details'); detail; detail = detail.parentElement?.closest('details') ?? null)
        detail.open = true;
      requestAnimationFrame(() => {
        invalid.focus();
        if (
          invalid instanceof HTMLInputElement ||
          invalid instanceof HTMLTextAreaElement ||
          invalid instanceof HTMLSelectElement
        )
          invalid.reportValidity();
      });
      return;
    }
    if (hasNext) changeStep(step + 1);
    else onSave();
  }

  const body = (
    <Dialog.Body px={{ base: '4', sm: '6' }} py="0" minH="0" css={{ scrollbarGutter: 'stable' }}>
      <form id={formId} onChange={() => setValidation(undefined)} noValidate onSubmit={submit}>
        <fieldset disabled={busy} style={{ minWidth: 0 }}>
          {sections.map(({ value, label }, index) =>
            creating ? (
              <Box
                key={value}
                as="section"
                aria-label={`第 ${index + 1} 步，${label}`}
                tabIndex={-1}
                hidden={step !== index}
                data-section={value}
                py="5"
              >
                {panels[value]}
              </Box>
            ) : (
              <Tabs.Content key={value} value={value} data-section={value} py="5">
                {panels[value]}
              </Tabs.Content>
            ),
          )}
        </fieldset>
      </form>
    </Dialog.Body>
  );
  return (
    <Dialog.Root
      open
      placement="center"
      size="xl"
      scrollBehavior="inside"
      closeOnEscape={!busy}
      closeOnInteractOutside={!busy}
      onOpenChange={({ open }) => {
        if (!open && !busy) close();
      }}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content
            mx="3"
            maxW="42rem"
            h="40rem"
            maxH="calc(100dvh - 24px)"
            minW="0"
            borderRadius="xl"
            overflow="hidden"
          >
            <Dialog.Header gap="3" px={{ base: '4', sm: '6' }} alignItems="center" flex="none">
              <Dialog.Title flex="1">{creating ? '添加渠道' : '编辑渠道'}</Dialog.Title>
              <Switch.Root
                checked={enabled}
                onCheckedChange={({ checked }) => onEnabledChange(checked)}
                disabled={busy}
                size="sm"
                colorPalette="green"
              >
                <Switch.HiddenInput aria-label="启用渠道" />
                <Switch.Control />
                <Switch.Label>{enabled ? '启用' : '停用'}</Switch.Label>
              </Switch.Root>
              <Dialog.CloseTrigger asChild position="static">
                <IconButton aria-label="关闭" size="sm" variant="ghost" disabled={busy}>
                  <X size={16} />
                </IconButton>
              </Dialog.CloseTrigger>
            </Dialog.Header>
            {creating ? (
              <>
                <Steps.Root
                  step={step}
                  count={sections.length}
                  size="xs"
                  colorPalette="purple"
                  px={{ base: '4', sm: '6' }}
                  pb="3"
                  borderBottomWidth="1px"
                >
                  <HStack as="ol" gap={{ base: '1', sm: '3' }} justify="space-between" aria-label="添加渠道步骤">
                    {sections.map(({ value, label }, index) => (
                      <Steps.Item key={value} as="li" index={index} gap={{ base: '1', sm: '2' }}>
                        <Steps.Indicator aria-hidden="true" boxSize={{ base: '5', sm: '6' }}>
                          <Steps.Status complete={<Check size={12} />} incomplete={<Steps.Number />} />
                        </Steps.Indicator>
                        <Steps.Title
                          fontSize={{ base: 'xs', sm: 'sm' }}
                          fontWeight={step === index ? '600' : '400'}
                          whiteSpace="nowrap"
                        >
                          {label}
                        </Steps.Title>
                        <Steps.Separator mx="0" />
                      </Steps.Item>
                    ))}
                  </HStack>
                </Steps.Root>
                {body}
              </>
            ) : (
              <Tabs.Root
                value={section.value}
                onValueChange={({ value }) => changeStep(sections.findIndex((item) => item.value === value))}
                _horizontal={{ display: 'flex' }}
                flex="1"
                flexDirection="column"
                minH="0"
                size="sm"
              >
                <Tabs.List
                  px={{ base: '4', sm: '6' }}
                  gap={{ base: '2', sm: '6' }}
                  flexShrink="0"
                  aria-label="渠道配置分区"
                >
                  {sections.map(({ value, label }) => (
                    <Tabs.Trigger
                      key={value}
                      value={value}
                      px="0"
                      fontSize={{ base: 'xs', sm: 'sm' }}
                      whiteSpace="nowrap"
                      _selected={{ color: 'gray.900', '--indicator-color': brandColor }}
                    >
                      {label}
                    </Tabs.Trigger>
                  ))}
                </Tabs.List>
                {body}
              </Tabs.Root>
            )}
            <Dialog.Footer
              borderTopWidth="1px"
              borderColor="gray.200"
              px={{ base: '4', sm: '6' }}
              flexShrink="0"
              flexWrap="wrap"
            >
              {(validation || error) && (
                <Box flexBasis="100%">
                  <ErrorText>{validation ?? error}</ErrorText>
                </Box>
              )}
              {creating ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => changeStep(step - 1)}
                  disabled={busy || step === 0}
                >
                  上一步
                </Button>
              ) : (
                <Button type="button" variant="ghost" size="sm" onClick={close} disabled={busy}>
                  取消
                </Button>
              )}
              <PrimaryButton size="sm" minW="24" form={formId} type="submit" loading={saving} disabled={busy}>
                {hasNext ? '下一步' : '保存渠道'}
              </PrimaryButton>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
