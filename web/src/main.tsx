import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';

import App from './App';
import { Authenticated } from './lib/auth';
import { queryClient } from './lib/trpc';
import Balance from './routes/Balance';
import ChangePassword from './routes/ChangePassword';
import Console, { AdminOnly } from './routes/Console';
import Keys from './routes/Keys';
import Landing from './routes/Landing';
import Login from './routes/Login';
import NotFound from './routes/NotFound';
import UserDetail from './routes/UserDetail';
import Users from './routes/Users';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');

createRoot(root).render(
  <StrictMode>
    <ChakraProvider value={defaultSystem}>
      <BrowserRouter>
        <QueryClientProvider client={queryClient}>
          <Routes>
            <Route element={<App />}>
              <Route index element={<Landing />} />
              <Route path="login" element={<Login />} />
              <Route element={<Authenticated />}>
                <Route path="change-password" element={<ChangePassword />} />
                <Route path="console" element={<Console />}>
                  <Route index element={<Balance />} />
                  <Route path="keys" element={<Keys />} />
                  <Route element={<AdminOnly />}>
                    <Route path="users" element={<Users />} />
                    <Route path="users/:userId" element={<UserDetail />} />
                  </Route>
                </Route>
              </Route>
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </QueryClientProvider>
      </BrowserRouter>
    </ChakraProvider>
  </StrictMode>,
);
