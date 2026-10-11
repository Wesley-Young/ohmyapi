import { ChakraProvider, defaultSystem } from '@chakra-ui/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';

import App from './App';
import { Loading } from './components/ui';
import { Authenticated } from './lib/auth';
import { queryClient } from './lib/trpc';
import Catalog from './routes/Catalog';
import ChangePassword from './routes/ChangePassword';
import Console, { AdminOnly } from './routes/Console';
import Keys from './routes/Keys';
import Landing from './routes/Landing';
import Login from './routes/Login';
import ModelPlaza from './routes/ModelPlaza';
import Models from './routes/Models';
import NotFound from './routes/NotFound';
import Overview from './routes/Overview';
import Profile from './routes/Profile';
import Requests from './routes/Requests';
import UserDetail from './routes/UserDetail';
import Users from './routes/Users';

const Playground = lazy(() => import('./routes/Playground'));

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
                    <Route path="channels" element={<Catalog />} />
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
