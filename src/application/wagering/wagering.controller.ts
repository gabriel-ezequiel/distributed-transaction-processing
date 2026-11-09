import {
  BadRequestException,
  ConflictException,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
  Body,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  IdempotencyConflictError,
  ProcessWagerTransaction,
  ProcessWagerTransactionCommand,
  WagerTransactionNotFoundError,
} from './process-wager-transaction.js';
import { hashCanonicalWagerPayload } from './canonical-payload.js';
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from '../../domain/wager-transaction/wager-transaction.js';
import { InvalidMoneyError, Money } from '../../domain/money/money.js';

/** JSON body accepted by the wagering transaction endpoint. */
export interface SubmitWagerTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: Exclude<WagerTransactionKind, WagerTransactionKind.Opening>;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string;
}

/**
 * HTTP adapter for the shared financial processing use case.
 */
@Controller('wagering')
export class WageringController {
  constructor(
    private readonly processWagerTransaction: ProcessWagerTransaction,
  ) {}

  /**
   * Processes one provider transaction with durable idempotency.
   *
   * `Idempotency-Key` is not included in the payload hash; it identifies the
   * durable record while the business payload detects conflicting replays.
   */
  @Post('transactions')
  @HttpCode(201)
  async submit(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-correlation-id') correlationId?: string,
  ) {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const validated = validateBody(body);
    const payloadHash = hashCanonicalWagerPayload(validated);
    const command: ProcessWagerTransactionCommand = {
      ...validated,
      idempotencyKey,
      payloadHash,
      correlationId: correlationId?.trim() || idempotencyKey,
    };

    try {
      const result = await this.processWagerTransaction.execute(command);
      if (result.status === WagerTransactionStatus.PendingReference) {
        response.statusCode = 202;
        return {
          ...result,
          idempotentReplay: result.idempotentReplay,
        };
      }
      if (result.status === WagerTransactionStatus.Rejected) {
        response.statusCode = 422;
      }
      return result;
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException(error.message);
      }
      if (error instanceof WagerTransactionNotFoundError) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}

function validateBody(body: unknown): SubmitWagerTransactionBody {
  if (body === null || typeof body !== 'object') {
    throw new BadRequestException('Request body must be an object');
  }
  const value = body as Record<string, unknown>;
  const requiredTextFields = [
    'providerId',
    'externalTransactionId',
    'playerId',
    'walletId',
    'roundId',
    'gameId',
  ] as const;
  for (const field of requiredTextFields) {
    if (typeof value[field] !== 'string' || value[field].trim() === '') {
      throw new BadRequestException(`${field} must be a non-empty string`);
    }
  }

  if (
    typeof value.kind !== 'string' ||
    !Object.values(WagerTransactionKind).includes(
      value.kind as WagerTransactionKind,
    ) ||
    value.kind === WagerTransactionKind.Opening
  ) {
    throw new BadRequestException('kind is not a valid external operation');
  }
  if (
    value.referenceExternalTransactionId !== undefined &&
    (typeof value.referenceExternalTransactionId !== 'string' ||
      value.referenceExternalTransactionId.trim() === '')
  ) {
    throw new BadRequestException(
      'referenceExternalTransactionId must be a non-empty string',
    );
  }

  if (value.money === null || typeof value.money !== 'object') {
    throw new BadRequestException('money must be an object');
  }
  const money = value.money as Record<string, unknown>;
  if (
    typeof money.amount !== 'string' ||
    typeof money.currency !== 'string' ||
    money.amount.trim() === '' ||
    money.currency.trim() === ''
  ) {
    throw new BadRequestException(
      'money.amount and money.currency are required strings',
    );
  }
  try {
    Money.from({
      amount: money.amount,
      currency: money.currency,
    });
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }

  return {
    providerId: value.providerId as string,
    externalTransactionId: value.externalTransactionId as string,
    playerId: value.playerId as string,
    walletId: value.walletId as string,
    roundId: value.roundId as string,
    gameId: value.gameId as string,
    kind: value.kind as SubmitWagerTransactionBody['kind'],
    money: {
      amount: money.amount,
      currency: money.currency,
    },
    ...(value.referenceExternalTransactionId
      ? {
          referenceExternalTransactionId:
            value.referenceExternalTransactionId as string,
        }
      : {}),
  };
}
