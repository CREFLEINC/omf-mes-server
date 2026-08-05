import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { WarehouseQueryDto } from './warehouse.query.dto';
import { WarehouseService } from './warehouse.service';

@ApiTags('기준정보')
@Controller('mdm/warehouses')
export class WarehouseController {
  constructor(private readonly service: WarehouseService) {}

  @Get()
  @ApiOperation({ summary: '창고 목록' })
  findAll(@Query() query: WarehouseQueryDto) {
    return this.service.findAll(query);
  }
}
