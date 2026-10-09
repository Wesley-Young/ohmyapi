import {
  IconButton as ChakraIconButton,
  Tooltip as ChakraTooltip,
  type IconButtonProps,
  Portal,
} from '@chakra-ui/react';
import { forwardRef, type ReactNode } from 'react';

export function Tooltip({
  content,
  children,
  triggerId,
}: {
  content: string;
  children: ReactNode;
  triggerId?: string;
}) {
  return (
    <ChakraTooltip.Root
      ids={{ trigger: triggerId }}
      openDelay={300}
      closeDelay={0}
      positioning={{ placement: 'top', strategy: 'fixed' }}
    >
      <ChakraTooltip.Trigger asChild>{children}</ChakraTooltip.Trigger>
      <Portal>
        <ChakraTooltip.Positioner>
          <ChakraTooltip.Content>{content}</ChakraTooltip.Content>
        </ChakraTooltip.Positioner>
      </Portal>
    </ChakraTooltip.Root>
  );
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps & { 'aria-label': string }>(function IconButton(
  { title, ...props },
  ref,
) {
  return (
    <Tooltip content={title ?? props['aria-label']} triggerId={props.id}>
      <ChakraIconButton type="button" ref={ref} {...props} _disabled={{ pointerEvents: 'auto', ...props._disabled }} />
    </Tooltip>
  );
});
