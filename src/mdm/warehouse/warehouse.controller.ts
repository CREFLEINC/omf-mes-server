import { Controller, Get, Header, Param, ParseIntPipe, Query, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { RequirePermissions } from '../../auth/auth.decorators';
import type { components } from '../../contracts/mdm';
import { WarehouseQueryDto } from './warehouse.query.dto';
import { WarehouseService } from './warehouse.service';

@ApiTags('기준정보')
@RequirePermissions('MASTER_READ')
@Controller('mdm/warehouses')
export class WarehouseController {
  constructor(private readonly service: WarehouseService) {}

  @Get()
  @ApiOperation({ summary: '창고 목록' })
  findAll(@Query() query: WarehouseQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':warehouseId')
  @ApiOperation({ summary: '창고 상세' })
  @ApiResponse({ status: 404, description: '없는 창고' })
  // 캐시된 응답을 쓰면 낡은 version_no 로 편집 화면이 열려, 저장할 때 남 탓이 아닌
  // 409 를 맞는다. 이 응답은 편집 화면의 입력이므로 저장하지 않는다.
  @Header('Cache-Control', 'no-store')
  async findOne(
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['WarehouseDetailResponse']> {
    const { body, versionNo } = await this.service.findOne(BigInt(warehouseId));

    // 낙관적 잠금 토큰. 다음 쓰기의 If-Match 에 그대로 담긴다(공유계약 B-1).
    // version_no 는 본문에 내리지 않는다(A-4) — 표시하지 않되 전달한다.
    response.setHeader('ETag', String(versionNo));

    return body;
  }
}
