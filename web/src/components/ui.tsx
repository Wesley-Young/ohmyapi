import {
  Box,
  Button,
  type ButtonProps,
  Dialog,
  Field,
  Flex,
  Heading,
  HStack,
  Input,
  type InputProps,
  Portal,
  Spinner,
  Stack,
  Text,
} from '@chakra-ui/react';
import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useId, useState } from 'react';

import { formError } from '../lib/format';

export function PrimaryButton(props: ButtonProps) {
  return (
    <Button
      bg="#635bff"
      color="white"
      borderRadius="full"
      px="6"
      fontWeight="600"
      _hover={{ bg: '#5146e6' }}
      {...props}
    />
  );
}
export function Centered({ children }: { children: ReactNode }) {
  return (
    <Flex minH="100dvh" align="center" justify="center" px="6" py="10">
      <Box w="full" maxW="360px">
        {children}
      </Box>
    </Flex>
  );
}
export function Panel({ children }: { children: ReactNode }) {
  return (
    <Box borderWidth="1px" borderColor="gray.200" borderRadius="xl" p={{ base: 5, md: 6 }}>
      {children}
    </Box>
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
      <Input {...props} id={id} borderRadius="lg" h="11" focusRingColor="#635bff" />
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
}: {
  label: string;
  description: string;
  action: () => Promise<unknown>;
  onSuccess?: () => Promise<unknown>;
  disabled?: boolean;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
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
      <Dialog.Trigger asChild>
        <Button
          variant={danger ? 'ghost' : 'outline'}
          color={danger ? 'red.600' : undefined}
          size="sm"
          disabled={disabled}
        >
          {label}
        </Button>
      </Dialog.Trigger>
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
              <Button aria-label="关闭" variant="ghost" size="sm" position="absolute" right="3" top="3" disabled={busy}>
                ×
              </Button>
            </Dialog.CloseTrigger>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
