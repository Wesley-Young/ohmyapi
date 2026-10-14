import { Heading, Stack } from '@chakra-ui/react';
import { useNavigate } from 'react-router';

import { ChangePasswordForm } from '../components/change-password';
import { Centered } from '../components/ui';

export default function ChangePassword() {
  const navigate = useNavigate();
  return (
    <ChangePasswordForm
      heading={
        <Stack gap="2">
          <Heading as="h1" fontSize="28px" letterSpacing="-0.04em">
            修改密码
          </Heading>
        </Stack>
      }
      cancelLabel="返回控制台"
      onSaved={() => navigate('/console', { replace: true })}
      onCancel={() => navigate('/console')}
      frame={(content) => <Centered>{content}</Centered>}
    />
  );
}
