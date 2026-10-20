/**
 * HealthController — the liveness probe.
 *
 *   GET /healthz   — liveness; 200 as long as the process is up
 *
 * No database, no auth, no deps. If this handler runs, the
 * process is alive. A future PR can split liveness from
 * readiness (a `/readyz` that asserts Postgres + provider
 * connectivity); the smoke step in CI can then drive both.
 */
import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';

import { HealthResponseDto } from '../dto/health.dto';

const VERSION = '0.0.1'; // Bumped per release; not env-driven in V1.

@Controller('healthz')
export class HealthController {
  private readonly bootedAt = Date.now();

  @Get()
  @HttpCode(HttpStatus.OK)
  probe(): HealthResponseDto {
    return HealthResponseDto.from((Date.now() - this.bootedAt) / 1000, VERSION);
  }
}
