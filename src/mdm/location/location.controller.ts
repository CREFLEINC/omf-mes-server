import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import { ContractBadRequest, ErrorCode, fieldError } from '../../common/errors/contract-error';
import type { components } from '../../contracts/mdm';
import { CreateLocationDto } from './location.create.dto';
import { LocationQueryDto } from './location.query.dto';
import { LocationService } from './location.service';
import { UpdateLocationDto } from './location.update.dto';

@ApiTags('기준정보')
@RequirePermissions('MASTER_READ')
@Controller('mdm/locations')
export class LocationController {
  constructor(private readonly service: LocationService) {}

  @RequirePermissions('MASTER_LOGISTICS_WRITE')
  @Post()
  @ApiOperation({ summary: '로케이션 등록' })
  @ApiResponse({ status: 400, description: '검증 실패 — 계약 오류 봉투' })
  create(
    @Body() dto: CreateLocationDto,
    @ActorId() actorId: bigint,
  ): Promise<components['schemas']['Location']> {
    return this.service.create(dto, actorId);
  }

  @RequirePermissions('MASTER_LOGISTICS_WRITE')
  @Put(':locationId')
  @ApiOperation({ summary: '로케이션 수정 — 전체 교체. 계층 재배치 포함' })
  @ApiResponse({ status: 400, description: '검증 실패 — 자기 자신·순환 포함' })
  @ApiResponse({ status: 409, description: '낙관적 잠금 충돌 — ConflictResponse' })
  async update(
    @Param('locationId', ParseIntPipe) locationId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateLocationDto,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Location']> {
    const { body, versionNo } = await this.service.update(
      BigInt(locationId),
      parseIfMatch(ifMatch),
      dto,
      actorId,
    );

    response.setHeader('ETag', String(versionNo));

    return body;
  }

  @Get()
  @ApiOperation({ summary: '로케이션 목록 — warehouseId 필수' })
  findAll(@Query() query: LocationQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':locationId')
  @ApiOperation({ summary: '로케이션 상세' })
  @ApiResponse({ status: 404, description: '없는 로케이션' })
  // 캐시된 응답을 쓰면 낡은 version_no 로 편집 화면이 열려, 저장할 때 남 탓이 아닌
  // 409 를 맞는다. 이 응답은 편집 화면의 입력이므로 저장하지 않는다.
  @Header('Cache-Control', 'no-store')
  async findOne(
    @Param('locationId', ParseIntPipe) locationId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['LocationDetailResponse']> {
    const { body, versionNo } = await this.service.findOne(BigInt(locationId));

    // 낙관적 잠금 토큰. 다음 쓰기의 If-Match 에 그대로 담긴다(공유계약 B-1).
    response.setHeader('ETag', String(versionNo));

    return body;
  }
}

/** `If-Match` 는 계약이 필수로 정했다. 없으면 낙관적 잠금이 성립하지 않는다. */
function parseIfMatch(value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed <= 0) {
    throw new ContractBadRequest([
      fieldError('If-Match', ErrorCode.REQUIRED, '변경하려면 If-Match 에 버전을 담아야 합니다.'),
    ]);
  }

  return parsed;
}
