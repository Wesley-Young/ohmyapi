import { Box } from '@chakra-ui/react';
import { useEffect } from 'react';
import { Outlet } from 'react-router';

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
      color="#171717"
      fontFamily="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    >
      <Outlet />
    </Box>
  );
}
