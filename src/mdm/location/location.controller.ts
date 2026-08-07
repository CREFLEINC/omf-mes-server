import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  ParseIntPipe,
  HttpCode,
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

  /**
   * `:deactivate` 의 콜론은 Express 5(path-to-regexp 8)에서 파라미터 시작 기호다.
   * 이스케이프하지 않으면 부팅이 실패한다.
   */
  @RequirePermissions('MASTER_LOGISTICS_DEACTIVATE')
  @Post(':locationId\\:deactivate')
  // POST 의 Nest 기본값은 201 이다. 있는 행을 바꾸므로 계약은 200 이다.
  @HttpCode(200)
  @ApiOperation({ summary: '로케이션 사용 중지 — 물리 삭제는 제공하지 않는다' })
  @ApiResponse({ status: 400, description: '재고 잔량·사용 중 하위 자리 — STATE_LOCKED' })
  @ApiResponse({ status: 409, description: '낙관적 잠금 충돌 — ConflictResponse' })
  deactivate(
    @Param('locationId', ParseIntPipe) locationId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Location']> {
    return this.writeActiveFlag(response, this.service.deactivate(BigInt(locationId), parseIfMatch(ifMatch), actorId));
  }

  /** 계약에 없다 — 중지를 되돌릴 길이 없어 서버가 먼저 만든다. 계약 소유자에게 되돌릴 항목. */
  @RequirePermissions('MASTER_LOGISTICS_DEACTIVATE')
  @Post(':locationId\\:activate')
  @HttpCode(200)
  @ApiOperation({ summary: '로케이션 다시 사용 — 계약에 없는 서버 추가분' })
  @ApiResponse({ status: 400, description: '창고·상위 자리가 중지 상태 — STATE_LOCKED' })
  activate(
    @Param('locationId', ParseIntPipe) locationId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Location']> {
    return this.writeActiveFlag(response, this.service.activate(BigInt(locationId), parseIfMatch(ifMatch), actorId));
  }

  /** 중지와 되살리기가 응답을 만드는 방식이 같다 — ETag 를 붙이는 자리를 한 곳에 둔다. */
  private async writeActiveFlag(
    response: Response,
    written: Promise<{ body: components['schemas']['Location']; versionNo: number }>,
  ): Promise<components['schemas']['Location']> {
    const { body, versionNo } = await written;

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
