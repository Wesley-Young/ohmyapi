import {
  Box,
  Button,
  type ButtonProps,
  DataList,
  Dialog,
  Field,
  Flex,
  Heading,
  HStack,
  Input,
  type InputProps,
  Link,
  Portal,
  Progress,
  Spinner,
  Stack,
  type StackProps,
  Text,
} from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { formError } from '../lib/format';
import { brandColor, brandHoverColor, textColor } from '../lib/theme';
import { IconButton } from './icon-button';

export function PrimaryButton(props: ButtonProps) {
  return (
    <Button
      bg={brandColor}
      color="white"
      borderRadius="full"
      px="6"
      fontWeight="600"
      _hover={{ bg: brandHoverColor }}
      {...props}
    />
  );
}
/** Clickable name cell that triggers the row's primary action; use `asChild` for navigation links. */
export function NameAction(props: ButtonProps) {
  return (
    <Button
      variant="plain"
      h="auto"
      minW="0"
      maxW="full"
      p="0"
      color="inherit"
      fontSize="sm"
      fontWeight="500"
      textAlign="start"
      whiteSpace="normal"
      overflowWrap="anywhere"
      textDecoration="none"
      _hover={{ color: brandColor, textDecoration: 'none' }}
      _focusVisible={{ outline: `2px solid ${brandColor}`, outlineOffset: '4px' }}
      {...props}
    />
  );
}
/** Footer link to the about page for signed-out pages. */
export function AboutLink() {
  return (
    <Link asChild fontSize="sm" color="gray.500" textDecoration="none" _hover={{ color: brandColor }}>
      <RouterLink to="/about">关于</RouterLink>
    </Link>
  );
}
const footerHeight = '56px';

/** Compact single-column page; an optional footer sits at the bottom without shifting the centered content. */
export function Centered({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const content = (
    <Box w="full" maxW="360px">
      {children}
    </Box>
  );
  if (!footer)
    return (
      <Flex minH="100dvh" align="center" justify="center" px="6" py="10">
        {content}
      </Flex>
    );
  return (
    <Flex direction="column" minH="100dvh" px="6">
      <Box h={footerHeight} flexShrink="0" aria-hidden="true" />
      <Flex flex="1" align="center" justify="center" py="4">
        {content}
      </Flex>
      <Flex as="footer" h={footerHeight} flexShrink="0" align="center" justify="center">
        {footer}
      </Flex>
    </Flex>
  );
}

// 表格不换行，横向滚动时操作列固定在右侧；只设左边框颜色，保留行分隔线。
export const pinnedColumn = {
  position: 'sticky',
  right: '0',
  zIndex: '1',
  bg: 'white',
  borderLeftWidth: '1px',
  borderLeftColor: 'gray.100',
} as const;

export function Panel({ children }: { children: ReactNode }) {
  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: 5, md: 6 }}>
      {children}
    </Box>
  );
}
/** 弹窗内的分区，以细分隔线代替卡片边框。 */
export function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Stack as="section" gap="4" pt="6" borderTopWidth="1px" borderColor="gray.100">
      <HStack justify="space-between" align="start" gap="3" flexWrap="wrap">
        <Stack gap="1" minW="0">
          <Heading as="h3" fontSize="md" fontWeight="600">
            {title}
          </Heading>
          {hint && (
            <Text fontSize="sm" color="gray.500">
              {hint}
            </Text>
          )}
        </Stack>
        {action}
      </HStack>
      {children}
    </Stack>
  );
}
/** 弹窗顶部的只读概要：标签在上、值在下，各项横向排列并可换行；值区域等高，徽标与文字垂直居中。 */
export function Facts({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <DataList.Root orientation="vertical" flexDirection="row" flexWrap="wrap" columnGap="10" rowGap="4">
      {items.map(({ label, value }) => (
        <DataList.Item key={label} gap="1.5">
          <DataList.ItemLabel fontSize="sm" color="gray.500">
            {label}
          </DataList.ItemLabel>
          <DataList.ItemValue minH="6" alignItems="center" fontSize="sm" fontWeight="500" color="#171717">
            {value}
          </DataList.ItemValue>
        </DataList.Item>
      ))}
    </DataList.Root>
  );
}
/** 卡片中的运行指标：标签在上、数值在下，可附一条细进度条；`meter.value` 为 null 时只显示轨道。 */
export function Metric({
  label,
  extra,
  meter,
  children,
  ...props
}: Omit<StackProps, 'children'> & {
  label: string;
  extra?: ReactNode;
  meter?: { value: number | null; color: string; label: string };
  children: ReactNode;
}) {
  return (
    <Stack gap="1" minW="0" {...props}>
      <HStack gap="1.5" minH="5" fontSize="xs" color="gray.500" whiteSpace="nowrap">
        <Text truncate>{label}</Text>
        {extra}
      </HStack>
      <HStack
        gap="1.5"
        minH="5"
        fontSize="sm"
        fontWeight="500"
        color={textColor}
        fontVariantNumeric="tabular-nums"
        whiteSpace="nowrap"
      >
        {children}
      </HStack>
      {meter &&
        (meter.value === null ? (
          <Box h="1" bg="gray.100" borderRadius="full" />
        ) : (
          <Progress.Root value={Math.min(meter.value, 100)} aria-label={meter.label}>
            <Progress.Track h="1" bg="gray.100" borderRadius="full">
              <Progress.Range bg={meter.color} borderRadius="full" />
            </Progress.Track>
          </Progress.Root>
        ))}
    </Stack>
  );
}
/** 设置行：左侧为名称和说明，右侧为操作，两者垂直居中；窄屏时操作换到下方。 */
export function SettingRow({ title, hint, action }: { title: string; hint?: string; action: ReactNode }) {
  return (
    <Flex
      direction={{ base: 'column', sm: 'row' }}
      align={{ base: 'start', sm: 'center' }}
      justify="space-between"
      gap="3"
    >
      <Stack gap="0.5" minW="0">
        <Text fontSize="sm" fontWeight="500">
          {title}
        </Text>
        {hint && (
          <Text fontSize="sm" color="gray.500">
            {hint}
          </Text>
        )}
      </Stack>
      <Box flexShrink="0">{action}</Box>
    </Flex>
  );
}
export function Title({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <HStack justify="space-between" align="start" gap="4" flexWrap="wrap">
      <Heading as="h1" fontSize="28px" fontWeight="700" letterSpacing="-0.04em" overflowWrap="anywhere" minW="0">
        {children}
      </Heading>
      {action}
    </HStack>
  );
}
export function FormInput({
  label,
  error,
  helper,
  ...props
}: InputProps & { label: string; error?: string; helper?: string }) {
  const generatedId = useId();
  const id = props.id ?? generatedId;
  return (
    <Field.Root invalid={Boolean(error)}>
      <Field.Label htmlFor={id}>{label}</Field.Label>
      <Input {...props} id={id} borderRadius="lg" h="11" focusRingColor={brandColor} />
      {error && <Field.ErrorText>{error}</Field.ErrorText>}
      {helper && <Field.HelperText>{helper}</Field.HelperText>}
    </Field.Root>
  );
}
export function ErrorText({ children }: { children?: ReactNode }) {
  return children ? (
    <Text role="alert" color="red.600" fontSize="sm">
      {children}
    </Text>
  ) : null;
}
export function Loading() {
  return (
    <Flex py="10" justify="center" role="status" aria-label="加载中">
      <Spinner size="sm" color="gray.500" />
    </Flex>
  );
}
export function PageControls({
  page,
  hasMore,
  pending,
  onPage,
}: {
  page: number;
  hasMore: boolean;
  pending?: boolean;
  onPage: (page: number) => void;
}) {
  return (
    <HStack justify="end" gap="3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending || page === 0}
        onClick={() => onPage(page - 1)}
      >
        上一页
      </Button>
      <Text fontSize="sm" color="gray.500">
        第 {page + 1} 页
      </Text>
      <Button type="button" variant="outline" size="sm" disabled={pending || !hasMore} onClick={() => onPage(page + 1)}>
        下一页
      </Button>
    </HStack>
  );
}
export function ConfirmAction({
  label,
  description,
  action,
  onSuccess,
  disabled,
  danger,
  icon,
  open: controlledOpen,
  onClose,
}: {
  label: string;
  description: string;
  action: () => Promise<unknown>;
  onSuccess?: () => Promise<unknown>;
  disabled?: boolean;
  danger?: boolean;
  icon?: ReactNode;
  /** 传入时由调用方控制打开（如从菜单项打开），不渲染触发按钮。 */
  open?: boolean;
  onClose?: () => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const controlled = controlledOpen !== undefined;
  const open = controlled ? controlledOpen : uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (!controlled) setUncontrolledOpen(next);
    else if (!next) onClose?.();
  };
  const task = useMutation({
    mutationFn: action,
    onSuccess: async () => {
      await onSuccess?.();
      setOpen(false);
    },
  });
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(event) => {
        if (!task.isPending) {
          setOpen(event.open);
          task.reset();
        }
      }}
    >
      {!controlled && (
        <Dialog.Trigger asChild>
          {icon ? (
            <IconButton
              aria-label={label}
              variant={danger ? 'ghost' : 'outline'}
              color={danger ? 'red.600' : undefined}
              size="sm"
              disabled={disabled}
            >
              {icon}
            </IconButton>
          ) : (
            <Button
              variant={danger ? 'ghost' : 'outline'}
              color={danger ? 'red.600' : undefined}
              size="sm"
              disabled={disabled}
            >
              {label}
            </Button>
          )}
        </Dialog.Trigger>
      )}
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4">
            <Dialog.Header>
              <Dialog.Title>{label}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body>
              <Stack gap="4">
                <Text color="gray.600">{description}</Text>
                <ErrorText>{formError(task.error)?.message}</ErrorText>
              </Stack>
            </Dialog.Body>
            <Dialog.Footer>
              <Dialog.CloseTrigger asChild>
                <Button variant="ghost" disabled={task.isPending}>
                  关闭
                </Button>
              </Dialog.CloseTrigger>
              <PrimaryButton
                loading={task.isPending}
                onClick={() => task.mutate()}
                {...(danger ? { bg: 'red.600', _hover: { bg: 'red.700' } } : {})}
              >
                确认{label}
              </PrimaryButton>
            </Dialog.Footer>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}

/** Form dialogs preserve keyboard focus, escape handling and scrollable small-screen layouts. */
export function FormDialog({
  open,
  onClose,
  title,
  busy,
  size = 'lg',
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  busy?: boolean;
  size?: 'lg' | 'xl';
  children: ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open && !busy) onClose();
      }}
      closeOnEscape={!busy}
      closeOnInteractOutside={!busy}
      placement="center"
      scrollBehavior="inside"
      size={size}
    >
      <Portal>
        <Dialog.Backdrop />
        <Dialog.Positioner>
          <Dialog.Content mx="4" maxH="calc(100dvh - 32px)">
            <Dialog.Header>
              <Dialog.Title>{title}</Dialog.Title>
            </Dialog.Header>
            <Dialog.Body pb="6">{children}</Dialog.Body>
            <Dialog.CloseTrigger asChild>
              <IconButton
                aria-label="关闭"
                variant="ghost"
                size="sm"
                position="absolute"
                right="3"
                top="3"
                disabled={busy}
              >
                <X size={16} aria-hidden="true" />
              </IconButton>
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
