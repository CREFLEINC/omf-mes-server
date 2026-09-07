import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import { PagedResponse } from '../../common/pagination';
import { SerialNumberListQuery, SerialNumberQueryService } from './serial-number-query.service';
import { SerialNumberView } from './serial-number-view';

@Controller('trace/serial-numbers')
export class SerialNumberController {
  constructor(private readonly serialNumbers: SerialNumberQueryService) {}

  @Get()
  @Contract('GET /trace/serial-numbers')
  list(@Query() query: SerialNumberListQuery): Promise<PagedResponse<SerialNumberView>> {
    return this.serialNumbers.list(query);
  }
}
