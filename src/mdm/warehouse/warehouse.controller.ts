import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
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
import type { components } from '../../contracts/mdm';
import { ContractBadRequest, ErrorCode, fieldError } from '../../common/errors/contract-error';
import { CreateWarehouseDto } from './warehouse.create.dto';
import { WarehouseQueryDto } from './warehouse.query.dto';
import { WarehouseService } from './warehouse.service';
import { UpdateWarehouseDto } from './warehouse.update.dto';

@ApiTags('기준정보')
@RequirePermissions('MASTER_READ')
@Controller('mdm/warehouses')
export class WarehouseController {
  constructor(private readonly service: WarehouseService) {}

  @RequirePermissions('MASTER_LOGISTICS_WRITE')
  @Post()
  @ApiOperation({ summary: '창고 등록' })
  @ApiResponse({ status: 400, description: '검증 실패 — 계약 오류 봉투' })
  create(
    @Body() dto: CreateWarehouseDto,
    @ActorId() actorId: bigint,
  ): Promise<components['schemas']['Warehouse']> {
    return this.service.create(dto, actorId);
  }

  @RequirePermissions('MASTER_LOGISTICS_WRITE')
  @Put(':warehouseId')
  @ApiOperation({ summary: '창고 수정 — 전체 교체' })
  @ApiResponse({ status: 409, description: '낙관적 잠금 충돌 — ConflictResponse' })
  async update(
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateWarehouseDto,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Warehouse']> {
    const { body, versionNo } = await this.service.update(
      BigInt(warehouseId),
      parseIfMatch(ifMatch),
      dto,
      actorId,
    );

    // 다음 쓰기가 이 값을 If-Match 에 담는다. 재전송 시 멱등 인터셉터가 이 헤더까지 재생한다.
    response.setHeader('ETag', String(versionNo));

    return body;
  }

  /**
   * `:deactivate` 의 콜론은 Express 5(path-to-regexp 8)에서 파라미터 시작 기호다.
   * 이스케이프하지 않으면 `Missing text before "deactivate" param` 으로 부팅이 실패한다.
   */
  @RequirePermissions('MASTER_LOGISTICS_DEACTIVATE')
  @Post(':warehouseId\\:deactivate')
  // POST 의 Nest 기본값은 201 이다. 새로 만드는 것이 아니라 있는 행을 바꾸므로 계약은 200 이다.
  @HttpCode(200)
  @ApiOperation({ summary: '창고 사용 중지 — 물리 삭제는 제공하지 않는다' })
  @ApiResponse({ status: 400, description: '재고 잔량·사용 중 로케이션 — STATE_LOCKED' })
  @ApiResponse({ status: 409, description: '낙관적 잠금 충돌 — ConflictResponse' })
  async deactivate(
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Warehouse']> {
    const { body, versionNo } = await this.service.deactivate(
      BigInt(warehouseId),
      parseIfMatch(ifMatch),
      actorId,
    );

    response.setHeader('ETag', String(versionNo));

    return body;
  }

  /** 계약에 없다 — 중지를 되돌릴 길이 없어 서버가 먼저 만든다. 계약 소유자에게 되돌릴 항목. */
  @RequirePermissions('MASTER_LOGISTICS_DEACTIVATE')
  @Post(':warehouseId\\:activate')
  @HttpCode(200)
  @ApiOperation({ summary: '창고 다시 사용 — 계약에 없는 서버 추가분' })
  @ApiResponse({ status: 400, description: '공장·사업부가 중지 상태 — STATE_LOCKED' })
  @ApiResponse({ status: 409, description: '낙관적 잠금 충돌 — ConflictResponse' })
  async activate(
    @Param('warehouseId', ParseIntPipe) warehouseId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Warehouse']> {
    const { body, versionNo } = await this.service.activate(
      BigInt(warehouseId),
      parseIfMatch(ifMatch),
      actorId,
    );

    response.setHeader('ETag', String(versionNo));

    return body;
  }

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

/**
 * `If-Match` 는 계약이 필수로 정했다. 없으면 낙관적 잠금이 성립하지 않으므로
 * 통과시키지 않는다 — `Idempotency-Key` 와 같은 처리다.
 */
function parseIfMatch(value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed <= 0) {
    throw new ContractBadRequest([
      fieldError('If-Match', ErrorCode.REQUIRED, '변경하려면 If-Match 에 버전을 담아야 합니다.'),
    ]);
  }

  return parsed;
}
