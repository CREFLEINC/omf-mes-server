import { ServiceUnavailableException } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  function controller(queryRaw: jest.Mock): HealthController {
    return new HealthController({ $queryRaw: queryRaw } as unknown as PrismaService);
  }

  it('DB 연결이 살아 있으면 ok', async () => {
    const result = await controller(jest.fn().mockResolvedValue([{ '?column?': 1 }])).check();

    expect(result).toMatchObject({ status: 'ok', db: 'up' });
    expect(result.uptime).toBeGreaterThanOrEqual(0);
  });

  it('DB 연결이 끊기면 503 — 컨테이너 healthcheck 가 이걸 보고 unhealthy 를 판정한다', async () => {
    const check = controller(jest.fn().mockRejectedValue(new Error('connection refused'))).check();

    await expect(check).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
