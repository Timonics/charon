/**
 * HTTP DTOs for the health surface.
 *
 * V1: a single liveness probe (`GET /healthz`) that returns
 * 200 + `{ status: 'ok' }` as long as the process is up. The
 * readiness probe (`/readyz`) is intentionally NOT shipped
 * in V1 — it would have to assert database connectivity, and
 * adding it is one extra thing to monitor in a smoke step.
 * A future PR can split liveness from readiness.
 */
export class HealthResponseDto {
  status!: 'ok';
  uptimeSeconds!: number;
  version!: string;

  static from(uptimeSeconds: number, version: string): HealthResponseDto {
    const dto = new HealthResponseDto();
    dto.status = 'ok';
    dto.uptimeSeconds = Math.floor(uptimeSeconds);
    dto.version = version;
    return dto;
  }
}
