import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

import { PrismaService } from '../prisma/prisma.service';

@ApiTags('운영 — 헬스체크')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** 컨테이너 healthcheck·로드밸런서가 호출한다. DB 연결까지 확인해야 '기동 완료'로 본다. */
  @Get()
  @ApiOperation({ summary: '서비스 상태 — DB 연결 포함' })
  @ApiResponse({ status: 200, description: '정상' })
  @ApiResponse({ status: 503, description: 'DB 연결 실패' })
  async check(): Promise<{ status: string; db: string; uptime: number }> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: 'error', db: 'down' });
    }

    return { status: 'ok', db: 'up', uptime: Math.floor(process.uptime()) };
  }
}
