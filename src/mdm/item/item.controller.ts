import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Param,
  ParseIntPipe,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';

import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import { ContractBadRequest, ErrorCode, fieldError } from '../../common/errors/contract-error';
import type { components } from '../../contracts/mdm';
import { ItemQueryDto } from './item.query.dto';
import { ItemService } from './item.service';
import { UpdateItemDto } from './item.update.dto';

/**
 * 품목은 **ERP 수신본**이라 등록(`POST`)도 중지(`:deactivate`)도 계약에 없다.
 * `PUT` 은 MES 확장 속성만 갱신한다 — 원본 4열은 DTO 가 받지 않는다.
 */
@ApiTags('기준정보')
@RequirePermissions('MASTER_READ')
@Controller('mdm/items')
export class ItemController {
  constructor(private readonly service: ItemService) {}

  @RequirePermissions('MASTER_PRODUCTION_WRITE')
  @Put(':itemId')
  @ApiOperation({ summary: '품목 MES 확장 속성 수정 — 원본 4열은 읽기 전용' })
  @ApiResponse({ status: 400, description: '검증 실패 — 원본 4열을 보내도 400' })
  @ApiResponse({ status: 409, description: '낙관적 잠금 충돌 — ConflictResponse' })
  async update(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateItemDto,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Item']> {
    const { body, versionNo } = await this.service.update(
      BigInt(itemId),
      parseIfMatch(ifMatch),
      dto,
      actorId,
    );

    response.setHeader('ETag', String(versionNo));

    return body;
  }

  @Get()
  @ApiOperation({ summary: '품목 목록 — hasRouting 으로 Routing 미보유만 거를 수 있다' })
  findAll(@Query() query: ItemQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':itemId')
  @ApiOperation({ summary: '품목 상세 — 원본과 MES 확장 속성을 함께 준다' })
  @ApiResponse({ status: 404, description: '없는 품목' })
  // 캐시된 응답을 쓰면 낡은 version_no 로 편집 화면이 열려, 저장할 때 남 탓이 아닌
  // 409 를 맞는다. 이 응답은 편집 화면의 입력이므로 저장하지 않는다.
  @Header('Cache-Control', 'no-store')
  async findOne(
    @Param('itemId', ParseIntPipe) itemId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['ItemDetailResponse']> {
    const { body, versionNo } = await this.service.findOne(BigInt(itemId));

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
