import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';

import App from './App';
import { AdminOnly, Authenticated } from './components/route-guards';
import { Loading } from './components/ui';
import { queryClient } from './lib/trpc';
import ChangePassword from './routes/change-password';
import Channels from './routes/channels';
import Console from './routes/console';
import Keys from './routes/keys';
import Landing from './routes/landing';
import Login from './routes/login';
import ModelPlaza from './routes/model-plaza';
import Models from './routes/models';
import NotFound from './routes/not-found';
import Overview from './routes/overview';
import Profile from './routes/profile';
import Requests from './routes/requests';
import UserDetail from './routes/user-detail';
import Users from './routes/users';

const Playground = lazy(() => import('./routes/playground'));

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
                  <Route index element={<Overview />} />
                  <Route path="requests" element={<Requests />} />
                  <Route path="model-plaza" element={<ModelPlaza />} />
                  <Route path="keys" element={<Keys />} />
                  <Route
                    path="playground"
                    element={
                      <Suspense fallback={<Loading />}>
                        <Playground />
                      </Suspense>
                    }
                  />
                  <Route path="profile" element={<Profile />} />
                  <Route element={<AdminOnly />}>
                    <Route path="channels" element={<Channels />} />
                    <Route path="models" element={<Models />} />
                    <Route path="models/:modelId/pricing" element={<Models />} />
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
