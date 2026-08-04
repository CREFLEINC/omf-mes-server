import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../prisma/prisma.service';

@ApiTags('운영')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: '서비스 상태 — DB 연결 포함' })
  @ApiResponse({ status: 200, description: '정상' })
  @ApiResponse({ status: 503, description: 'DB 연결 실패' })
  async check(): Promise<{ status: string; db: string; uptime: number }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      // docker-compose.prod.yml 의 healthcheck 가 이 응답 코드로 unhealthy 를 판정한다.
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }

    return { status: 'ok', db: 'up', uptime: Math.floor(process.uptime()) };
  }
}
