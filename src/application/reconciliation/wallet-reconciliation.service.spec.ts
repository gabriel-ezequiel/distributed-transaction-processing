import { EntityManager } from '@mikro-orm/postgresql';
import { WalletReconciliationService } from './wallet-reconciliation.service.js';

describe('WalletReconciliationService', () => {
  it('reconstructs the balance and reports a consistent wallet', async () => {
    const wallet = {
      id: 'wallet-1',
      balanceAmount: '85.00',
      currency: 'BRL',
    };
    const entries = [
      {
        id: 'entry-1',
        direction: 'CREDIT',
        amount: '100.00',
        currency: 'BRL',
        balanceBefore: '0.00',
        balanceAfter: '100.00',
      },
      {
        id: 'entry-2',
        direction: 'DEBIT',
        amount: '15.00',
        currency: 'BRL',
        balanceBefore: '100.00',
        balanceAfter: '85.00',
      },
    ];
    const execute = vi
      .fn()
      .mockResolvedValueOnce([wallet])
      .mockResolvedValueOnce(entries);
    const service = new WalletReconciliationService({
      getConnection: () => ({ execute }),
    } as unknown as EntityManager);

    await expect(service.reconcile('wallet-1')).resolves.toMatchObject({
      walletId: 'wallet-1',
      consistent: true,
      entriesChecked: 2,
      difference: { amount: '0.00', currency: 'BRL' },
    });
  });

  it('reports a persisted balance divergence without correcting it', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'wallet-1',
          balanceAmount: '90.00',
          currency: 'BRL',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'entry-1',
          direction: 'CREDIT',
          amount: '100.00',
          currency: 'BRL',
          balanceBefore: '0.00',
          balanceAfter: '100.00',
        },
      ]);
    const service = new WalletReconciliationService({
      getConnection: () => ({ execute }),
    } as unknown as EntityManager);

    await expect(service.reconcile('wallet-1')).resolves.toMatchObject({
      consistent: false,
      difference: { amount: '-10.00', currency: 'BRL' },
      divergences: ['wallet:balance-mismatch'],
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('raises an explicit error for an unknown wallet', async () => {
    const service = new WalletReconciliationService({
      getConnection: () => ({
        execute: vi.fn().mockResolvedValueOnce([]),
      }),
    } as unknown as EntityManager);

    await expect(service.reconcile('missing')).rejects.toThrow(
      'Wallet not found: missing',
    );
  });
});
