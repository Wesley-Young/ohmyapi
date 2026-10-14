import { Button, HStack, Stack, Text } from '@chakra-ui/react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

import { formError } from '../lib/format';
import { trpc } from '../lib/trpc';
import { ErrorText, FormDialog, Loading } from './ui';

export function WalletReconciliation({ userId }: { userId: string }) {
  const [open, setOpen] = useState(false);
  const data = useQuery(trpc.admin.billing.reconcile.queryOptions({ userId }, { enabled: open }));
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          void data.refetch();
          setOpen(true);
        }}
      >
        核对钱包
      </Button>
      {open && (
        <FormDialog open title="钱包一致性核对" onClose={() => setOpen(false)}>
          <Stack gap="4">
            <ErrorText>{formError(data.error)?.message}</ErrorText>
            {data.isPending ? (
              <Loading />
            ) : (
              data.data && (
                <>
                  <Text fontWeight="600">
                    {data.data.consistent ? '钱包、流水与请求冻结一致' : '存在账务差异，请核对流水'}
                  </Text>
                  {[
                    ['钱包余额', data.data.balance],
                    ['流水累计余额', data.data.ledgerBalance],
                    ['钱包冻结', data.data.reserved],
                    ['流水累计冻结', data.data.ledgerReserved],
                    ['请求冻结合计', data.data.requestHeld],
                  ].map(([label, value]) => (
                    <HStack key={label} justify="space-between">
                      <Text fontSize="sm">{label}</Text>
                      <Text fontFamily="mono" fontSize="sm">
                        {value} {data.data.currency}
                      </Text>
                    </HStack>
                  ))}
                </>
              )
            )}
          </Stack>
        </FormDialog>
      )}
    </>
  );
}
