import { ListQueuesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

export interface ReadinessResult {
  status: 'ok' | 'error';
  checks: {
    database: 'up' | 'down';
    sqs: 'up' | 'down';
  };
  errors?: Record<string, string>;
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    private readonly entityManager: EntityManager,
    private readonly sqsClient: SQSClient,
  ) {}

  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async ready(): Promise<ReadinessResult> {
    const checks: ReadinessResult['checks'] = {
      database: 'down',
      sqs: 'down',
    };
    const errors: Record<string, string> = {};

    try {
      await this.entityManager.getConnection().execute('select 1');
      checks.database = 'up';
    } catch (error: unknown) {
      errors.database = this.describeError(error);
    }

    try {
      await this.sqsClient.send(new ListQueuesCommand({ MaxResults: 1 }));
      checks.sqs = 'up';
    } catch (error: unknown) {
      errors.sqs = this.describeError(error);
    }

    const result: ReadinessResult = {
      status: checks.database === 'up' && checks.sqs === 'up' ? 'ok' : 'error',
      checks,
    };
    if (Object.keys(errors).length > 0) {
      result.errors = errors;
      this.logger.warn(
        JSON.stringify({
          event: 'readiness_check_failed',
          checks,
          failedDependencies: Object.keys(errors),
        }),
      );
    }
    return result;
  }

  private describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
