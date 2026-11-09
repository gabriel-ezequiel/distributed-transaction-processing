import { Controller, Get, HttpException, HttpStatus } from '@nestjs/common';
import { HealthService } from './health.service.js';
import { ApplicationMetrics } from '../observability/application-metrics.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly healthService: HealthService,
    private readonly metricsService: ApplicationMetrics,
  ) {}

  @Get('live')
  live(): { status: 'ok' } {
    return this.healthService.live();
  }

  @Get('ready')
  async ready() {
    const result = await this.healthService.ready();
    if (result.status === 'error') {
      throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return result;
  }

  @Get('metrics')
  metrics() {
    return this.metricsService.snapshot();
  }
}
