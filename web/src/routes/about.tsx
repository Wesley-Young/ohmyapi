import { Link, Stack, Text } from '@chakra-ui/react';
import { ArrowLeft, ExternalLink } from 'lucide-react';
import { Link as RouterLink } from 'react-router';

import { Logo } from '../components/logo';
import { Centered } from '../components/ui';
import { useAuth } from '../lib/auth';
import { brandColor } from '../lib/theme';

const repository = 'https://github.com/Wesley-Young/ohmyapi';

export default function About() {
  const auth = useAuth();
  const back = auth.data ? { to: '/console', label: '返回控制台' } : { to: '/', label: '返回首页' };
  return (
    <Centered>
      <Stack gap="7">
        <Stack gap="4">
          <Logo fontSize="32px" />
          <Text color="gray.600">Simple yet capable AI gateway, yours to extend.</Text>
        </Stack>
        <Stack gap="3" align="start" fontSize="sm">
          <Link href={repository} target="_blank" rel="noreferrer" fontWeight="500" _hover={{ color: brandColor }}>
            源代码
            <ExternalLink size={14} strokeWidth={1.6} aria-hidden="true" />
          </Link>
          <Link asChild color="gray.500" textDecoration="none" _hover={{ color: brandColor }}>
            <RouterLink to={back.to}>
              <ArrowLeft size={14} strokeWidth={1.6} aria-hidden="true" />
              {back.label}
            </RouterLink>
          </Link>
        </Stack>
      </Stack>
    </Centered>
  );
}
