import {
  Controller,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  WalletReconciliationNotFoundError,
  WalletReconciliationService,
} from './wallet-reconciliation.service.js';

@Controller('wallets')
export class WalletReconciliationController {
  constructor(
    private readonly reconciliationService: WalletReconciliationService,
  ) {}

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    try {
      return await this.reconciliationService.reconcile(walletId);
    } catch (error) {
      if (error instanceof WalletReconciliationNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
