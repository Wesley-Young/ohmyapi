import { Flex } from '@chakra-ui/react';
import { Outlet } from 'react-router';

export default function App() {
  return (
    <Flex
      as="main"
      minH="100dvh"
      align="center"
      justify="center"
      bg="white"
      color="#171717"
      px="6"
      fontFamily="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    >
      <Outlet />
    </Flex>
  );
}
