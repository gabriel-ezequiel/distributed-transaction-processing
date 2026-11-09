import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { LedgerDirection } from '../../domain/ledger/wallet-ledger-entry.js';
import { Money } from '../../domain/money/money.js';

export interface WalletReconciliationResult {
  walletId: string;
  consistent: boolean;
  entriesChecked: number;
  persistedBalance: {
    amount: string;
    currency: string;
  };
  reconstructedBalance: {
    amount: string;
    currency: string;
  };
  difference: {
    amount: string;
    currency: string;
  };
  divergences: string[];
}

export class WalletReconciliationNotFoundError extends Error {
  constructor(walletId: string) {
    super(`Wallet not found: ${walletId}`);
    this.name = 'WalletReconciliationNotFoundError';
  }
}

@Injectable()
export class WalletReconciliationService {
  private readonly logger = new Logger(WalletReconciliationService.name);

  constructor(private readonly entityManager: EntityManager) {}

  async reconcile(walletId: string): Promise<WalletReconciliationResult> {
    return this.entityManager.transactional(async (transactionManager) => {
      const connection = transactionManager.getConnection();
      const walletRows = (await connection.execute(
        'select "id", "balance_amount" as "balanceAmount", "currency" from "wallets" where "id" = ? for share',
        [walletId],
      )) as WalletRow[];
      const wallet = walletRows[0];
      if (!wallet) {
        throw new WalletReconciliationNotFoundError(walletId);
      }

      const entries = (await connection.execute(
        `select "id", "direction", "amount", "currency",
          "balance_before" as "balanceBefore",
          "balance_after" as "balanceAfter"
          from "wallet_ledger_entries"
          where "wallet_id" = ?
          order by "created_at" asc, "id" asc`,
        [walletId],
      )) as LedgerRow[];
      const persistedBalance = Money.from({
        amount: wallet.balanceAmount,
        currency: wallet.currency,
      });
      const divergences: string[] = [];
      let reconstructedBalance = Money.zero(wallet.currency);

      let netMovement = Money.zero(wallet.currency);
      for (const entry of entries) {
        const before = Money.from({
          amount: entry.balanceBefore,
          currency: entry.currency,
        });
        const amount = Money.from({
          amount: entry.amount,
          currency: entry.currency,
        });
        const after = Money.from({
          amount: entry.balanceAfter,
          currency: entry.currency,
        });

        if (entry.currency !== wallet.currency) {
          divergences.push(`entry:${entry.id}:currency-mismatch`);
        }
        const expectedAfter =
          entry.direction === LedgerDirection.Debit
            ? before.subtract(amount)
            : before.add(amount);
        if (!expectedAfter.equals(after)) {
          divergences.push(`entry:${entry.id}:unbalanced`);
        }
        netMovement = netMovement.add(
          entry.direction === LedgerDirection.Debit ? amount.negate() : amount,
        );
      }
      if (entries.length > 0) {
        const afterBalances = new Set(
          entries.map((entry) => entry.balanceAfter),
        );
        const initialCandidates = entries.filter(
          (entry) => !afterBalances.has(entry.balanceBefore),
        );
        if (initialCandidates.length !== 1) {
          divergences.push('ledger:initial-balance-ambiguous');
        }
        const initialBalance = Money.from({
          amount: (initialCandidates[0] ?? entries[0]!).balanceBefore,
          currency: (initialCandidates[0] ?? entries[0]!).currency,
        });
        reconstructedBalance = initialBalance.add(netMovement);
      }

      if (!persistedBalance.equals(reconstructedBalance)) {
        divergences.push('wallet:balance-mismatch');
      }

      const difference = persistedBalance.subtract(reconstructedBalance);
      const result: WalletReconciliationResult = {
        walletId,
        consistent: divergences.length === 0,
        entriesChecked: entries.length,
        persistedBalance: persistedBalance.toJSON(),
        reconstructedBalance: reconstructedBalance.toJSON(),
        difference: difference.toJSON(),
        divergences,
      };

      if (!result.consistent) {
        this.logger.warn(
          JSON.stringify({
            event: 'wallet_reconciliation_divergence',
            walletId,
            entriesChecked: entries.length,
            divergenceCount: divergences.length,
          }),
        );
      }
      return result;
    });
  }
}

interface WalletRow {
  id: string;
  balanceAmount: string;
  currency: string;
}

interface LedgerRow {
  id: string;
  direction: LedgerDirection;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
}
