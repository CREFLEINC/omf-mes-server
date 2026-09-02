import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';

import { Contract } from '../../common/contract';
import { IdempotencyService } from '../../common/idempotency';
import { runIdempotent, runVersioned } from '../../common/master';
import { setEtag } from '../../common/optimistic-lock';
import { PagedResponse } from '../../common/pagination';
import { LocationQuery, LocationService } from './location.service';

/** 위치(로케이션) 마스터. 화면은 `W-06-07` 우측 Location 탭이다. */
@Controller('mdm/locations')
export class LocationController {
  constructor(
    private readonly locations: LocationService,
    private readonly idempotency: IdempotencyService,
  ) {}

  @Get()
  @Contract('GET /mdm/locations')
  list(@Query() query: LocationQuery): Promise<PagedResponse<unknown>> {
    return this.locations.list(query);
  }

  @Get(':locationId')
  @Contract('GET /mdm/locations/{locationId}')
  async get(
    @Param('locationId', ParseIntPipe) locationId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const { location, editability, versionNo } = await this.locations.get(locationId);
    // 계약이 이 자리에 ETag 를 선언했다 — 다음 쓰기의 If-Match 가 이 값을 담는다.
    setEtag(response, versionNo);
    // ⛔ 상세만 래퍼다(`LocationDetailResponse`). 수정·전이는 본체를 낸다.
    return { location, editability };
  }

  @Post()
  @Contract('POST /mdm/locations')
  create(@Req() request: Request, @Body() body: LocationCreateBody): Promise<unknown> {
    return runIdempotent(this.idempotency, request, HttpStatus.CREATED, () =>
      this.locations.create(body),
    );
  }

  @Put(':locationId')
  @Contract('PUT /mdm/locations/{locationId}')
  update(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('locationId', ParseIntPipe) locationId: number,
    @Body() body: LocationUpdateBody,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'location', (version) =>
      this.locations.update(locationId, version, body),
    );
  }

  @Post(':locationId\\:activate')
  @Contract('POST /mdm/locations/{locationId}:activate')
  @HttpCode(HttpStatus.OK)
  activate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('locationId', ParseIntPipe) locationId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'location', (version) =>
      this.locations.setActive(locationId, version, true),
    );
  }

  @Post(':locationId\\:deactivate')
  @Contract('POST /mdm/locations/{locationId}:deactivate')
  @HttpCode(HttpStatus.OK)
  deactivate(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Param('locationId', ParseIntPipe) locationId: number,
  ): Promise<unknown> {
    return runVersioned(this.idempotency, request, response, 'location', (version) =>
      this.locations.setActive(locationId, version, false),
    );
  }
}

interface LocationCreateBody {
  warehouseId: number;
  parentLocationId?: number | null;
  locationCode: string;
  locationName: string;
  locationTypeCode: string;
  qualityZoneCode?: string | null;
  storageConditionCode?: string | null;
  allowMixedItem?: boolean;
  allowMixedLot?: boolean;
  capacityQty?: number | null;
  capacityUomId?: number | null;
}

/**
 * ⛔ 수정은 `allowMixedItem`·`allowMixedLot` 를 «필수»로 받는다 — 등록과 다르다.
 * 계약이 그렇게 갈랐고, 등록의 기본값(둘 다 true)을 수정이 조용히 되돌리지 않게 한다.
 */
interface LocationUpdateBody extends Omit<LocationCreateBody, 'warehouseId'> {
  allowMixedItem: boolean;
  allowMixedLot: boolean;
}
