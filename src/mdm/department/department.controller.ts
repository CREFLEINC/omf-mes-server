import { Controller, Get, Header, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { RequirePermissions } from '../../auth/auth.decorators';
import type { components } from '../../contracts/mdm';
import { DepartmentQueryDto } from './department.query.dto';
import { DepartmentService } from './department.service';

@ApiTags('기준정보')
@RequirePermissions('MASTER_READ')
@Controller('mdm/departments')
export class DepartmentController {
  constructor(private readonly service: DepartmentService) {}

  @Get()
  @ApiOperation({ summary: '부서 목록' })
  findAll(@Query() query: DepartmentQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':departmentId')
  @ApiOperation({ summary: '부서 상세' })
  @ApiResponse({ status: 404, description: '없는 부서' })
  // 캐시된 응답을 쓰면 낡은 version_no 로 편집 화면이 열려, 저장할 때 남 탓이 아닌
  // 409 를 맞는다. 이 응답은 편집 화면의 입력이므로 저장하지 않는다.
  @Header('Cache-Control', 'no-store')
  async findOne(
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['DepartmentDetailResponse']> {
    const { body, versionNo } = await this.service.findOne(BigInt(departmentId));

    // 낙관적 잠금 토큰. 다음 쓰기의 If-Match 에 그대로 담긴다(공유계약 B-1).
    response.setHeader('ETag', String(versionNo));

    return body;
  }
}
