import { Body, Controller, HttpStatus, Post, Req } from '@nestjs/common';
import type { Request } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent } from '../../common/master';
import { LocationStructureService, RackCreate } from './location-structure.service';

/** `/mdm/locations:rack` — 경로가 `mdm/locations` 밑이 아니라(슬래시가 없다) 따로 둔다. */
@Controller('mdm')
export class LocationRackController {
  constructor(
    private readonly structure: LocationStructureService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Post('locations\\:rack')
  @Contract('POST /mdm/locations:rack')
  create(@Req() request: Request, @Body() body: RackCreate): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () => this.structure.createRack(body));
  }
}
