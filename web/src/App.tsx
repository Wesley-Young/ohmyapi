import { Box } from '@chakra-ui/react';
import { Outlet } from 'react-router';

export default function App() {
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
