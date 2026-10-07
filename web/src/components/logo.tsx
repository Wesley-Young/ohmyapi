import { Image, type ImageProps } from '@chakra-ui/react';

export function Logo(props: Omit<ImageProps, 'src' | 'alt'>) {
  return <Image src="/logo.svg" alt="ohmyapi" w="4.5em" h="1.125em" flexShrink="0" {...props} />;
}
