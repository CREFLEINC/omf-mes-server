import {
  Body,
  Controller,
  Delete,
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
import { LocationStructureService } from './location-structure.service';
import { LocationQuery, LocationService } from './location.service';

/** 위치(로케이션) 마스터. 화면은 `W-06-07` 우측 Location 탭이다. */
@Controller('mdm/locations')
export class LocationController {
  constructor(
    private readonly locations: LocationService,
    private readonly structure: LocationStructureService,
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

  @Delete(':locationId')
  @Contract('DELETE /mdm/locations/{locationId}')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Req() request: Request, @Param('locationId', ParseIntPipe) locationId: number): Promise<void> {
    await runIdempotent(this.idempotency, request, HttpStatus.NO_CONTENT, async () => {
      await this.structure.remove(locationId);
      return undefined;
    });
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

/** 계약 `LocationCreate` — 코드는 서버가 발행하고 단계는 상위로 정한다. */
interface LocationCreateBody {
  warehouseId: number;
  parentLocationId?: number | null;
  locationName: string;
  aliasName?: string | null;
  locationLevelCode?: string | null;
}

/** 계약 `LocationUpdate` — 이름과 별칭만 바꾼다. */
interface LocationUpdateBody {
  locationName: string;
  aliasName?: string | null;
}
