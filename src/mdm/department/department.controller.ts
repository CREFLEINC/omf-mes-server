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
import { ContractBadRequest, ErrorCode, fieldError } from '../../common/errors/contract-error';
import type { components } from '../../contracts/mdm';
import { CreateDepartmentDto } from './department.create.dto';
import { DepartmentQueryDto } from './department.query.dto';
import { DepartmentService } from './department.service';
import { UpdateDepartmentDto } from './department.update.dto';

@ApiTags('기준정보')
@RequirePermissions('MASTER_READ')
@Controller('mdm/departments')
export class DepartmentController {
  constructor(private readonly service: DepartmentService) {}

  @RequirePermissions('MASTER_ORGANIZATION_WRITE')
  @Post()
  @ApiOperation({ summary: '부서 등록' })
  @ApiResponse({ status: 400, description: '검증 실패 — 계약 오류 봉투' })
  create(
    @Body() dto: CreateDepartmentDto,
    @ActorId() actorId: bigint,
  ): Promise<components['schemas']['Department']> {
    return this.service.create(dto, actorId);
  }

  @RequirePermissions('MASTER_ORGANIZATION_WRITE')
  @Put(':departmentId')
  @ApiOperation({ summary: '부서 수정 — 전체 교체. 계층 재배치 포함' })
  @ApiResponse({ status: 400, description: '검증 실패 — 자기 자신·순환 포함' })
  @ApiResponse({ status: 409, description: '낙관적 잠금 충돌 — ConflictResponse' })
  async update(
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateDepartmentDto,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Department']> {
    const { body, versionNo } = await this.service.update(
      BigInt(departmentId),
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
  @RequirePermissions('MASTER_ORGANIZATION_DEACTIVATE')
  @Post(':departmentId\\:deactivate')
  // POST 의 Nest 기본값은 201 이다. 있는 행을 바꾸므로 계약은 200 이다.
  @HttpCode(200)
  @ApiOperation({ summary: '부서 사용 중지 — 물리 삭제는 제공하지 않는다' })
  @ApiResponse({ status: 400, description: '하위 부서·소속 인원 — STATE_LOCKED' })
  @ApiResponse({ status: 409, description: '낙관적 잠금 충돌 — ConflictResponse' })
  deactivate(
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Department']> {
    return this.writeActiveFlag(
      response,
      this.service.deactivate(BigInt(departmentId), parseIfMatch(ifMatch), actorId),
    );
  }

  /** 계약에 없다 — 중지를 되돌릴 길이 없어 서버가 먼저 만든다. 계약 소유자에게 되돌릴 항목. */
  @RequirePermissions('MASTER_ORGANIZATION_DEACTIVATE')
  @Post(':departmentId\\:activate')
  @HttpCode(200)
  @ApiOperation({ summary: '부서 다시 사용 — 계약에 없는 서버 추가분' })
  @ApiResponse({ status: 400, description: '상위 부서·사업부가 중지 상태 — STATE_LOCKED' })
  activate(
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Headers('if-match') ifMatch: string | undefined,
    @ActorId() actorId: bigint,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['Department']> {
    return this.writeActiveFlag(
      response,
      this.service.activate(BigInt(departmentId), parseIfMatch(ifMatch), actorId),
    );
  }

  /** 중지와 되살리기가 응답을 만드는 방식이 같다 — ETag 를 붙이는 자리를 한 곳에 둔다. */
  private async writeActiveFlag(
    response: Response,
    written: Promise<{ body: components['schemas']['Department']; versionNo: number }>,
  ): Promise<components['schemas']['Department']> {
    const { body, versionNo } = await written;

    response.setHeader('ETag', String(versionNo));

    return body;
  }

  @Get()
  @ApiOperation({ summary: '부서 목록' })
  findAll(@Query() query: DepartmentQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':departmentId')
  @ApiOperation({ summary: '부서 상세' })
  @ApiResponse({ status: 404, description: '없는 부서' })
  // 캐시된 응답을 쓰면 낡은 version_no 로 편집 화면이 열려, 저장할 때 남 탓이 아닌
  // 409 를 맞는다. 이 응답은 편집 화면의 입력이므로 저장하지 않는다.
  @Header('Cache-Control', 'no-store')
  async findOne(
    @Param('departmentId', ParseIntPipe) departmentId: number,
    @Res({ passthrough: true }) response: Response,
  ): Promise<components['schemas']['DepartmentDetailResponse']> {
    const { body, versionNo } = await this.service.findOne(BigInt(departmentId));

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
