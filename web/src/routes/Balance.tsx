import { Button, Heading, HStack, Stack } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { ErrorText, Loading, PageControls, Title } from '../components/ui';
import { Ledger, WalletSummary } from '../components/wallet';
import { formError } from '../lib/format';
import { queryClient, trpc } from '../lib/trpc';

export default function Balance() {
  const [page, setPage] = useState(0);
  const wallet = useQuery(
    trpc.wallet.get.queryOptions(undefined, { refetchOnMount: 'always', refetchInterval: 10000 }),
  );
  const ledger = useQuery(
    trpc.wallet.ledger.queryOptions({ page }, { refetchOnMount: 'always', refetchInterval: 10000 }),
  );
  return (
    <Stack gap="7">
      <Title
        action={
          <Button
            variant="outline"
            size="sm"
            loading={wallet.isFetching || ledger.isFetching}
            onClick={() => queryClient.invalidateQueries(trpc.wallet.pathFilter())}
          >
            刷新
          </Button>
        }
      >
        余额
      </Title>
      <ErrorText>{formError(wallet.error ?? ledger.error)?.message}</ErrorText>
      {wallet.isPending || ledger.isPending ? (
        <Loading />
      ) : (
        wallet.data &&
        ledger.data && (
          <>
            <WalletSummary wallet={wallet.data} />
            <Stack gap="4">
              <HStack>
                <Heading as="h2" fontSize="lg">
                  资金流水
                </Heading>
              </HStack>
              <Ledger items={ledger.data.items} />
              <PageControls page={page} hasMore={ledger.data.hasMore} onPage={setPage} />
            </Stack>
          </>
        )
      )}
    </Stack>
  );
}
