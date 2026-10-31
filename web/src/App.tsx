import { Box } from '@chakra-ui/react';
import { useEffect } from 'react';
import { Outlet } from 'react-router';

import { textColor } from './lib/theme';

export default function App() {
  useEffect(() => {
    if (import.meta.env.DEV) {
      // set title to indicate dev mode
      document.title = `ohmyapi (dev)`;
    }
  });

  return (
    <Box
      as="main"
      minH="100dvh"
      bg="white"
      color={textColor}
      fontFamily="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    >
      <Outlet />
    </Box>
  );
}
