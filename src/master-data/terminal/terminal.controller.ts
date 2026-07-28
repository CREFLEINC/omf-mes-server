import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ActorId, RequirePermissions } from '../../auth/auth.decorators';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ShiftService } from './shift.service';
import {
  CreateShiftDto,
  CreateTerminalDto,
  ShiftQueryDto,
  TerminalQueryDto,
  UpdateShiftDto,
  UpdateTerminalDto,
  UpsertTerminalProcessDto,
} from './terminal.dto';
import { TerminalService } from './terminal.service';

@ApiTags('기준정보 — 작업조')
@Controller('master/shifts')
export class ShiftController {
  constructor(private readonly service: ShiftService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '작업조 등록 — 시각은 HH:MM 또는 HH:MM:SS' })
  @ApiResponse({ status: 400, description: '시각 형식 오류 · 자정 넘김 표기 불일치' })
  @ApiResponse({ status: 409, description: '작업조 코드 중복' })
  create(@Body() dto: CreateShiftDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '작업조 목록' })
  findAll(@Query() query: ShiftQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':shiftCode')
  @ApiOperation({ summary: '작업조 단건 조회' })
  @ApiParam({ name: 'shiftCode', example: 'SHIFT_A' })
  findOne(@Param('shiftCode') shiftCode: string) {
    return this.service.findOne(shiftCode);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':shiftCode')
  @ApiOperation({ summary: '작업조 수정' })
  update(@Param('shiftCode') shiftCode: string, @Body() dto: UpdateShiftDto, @ActorId() actor?: bigint) {
    return this.service.update(shiftCode, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':shiftCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '작업조 비활성화' })
  deactivate(@Param('shiftCode') shiftCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(shiftCode, actor);
  }
}

@ApiTags('기준정보 — 단말')
@Controller('master/terminals')
export class TerminalController {
  constructor(private readonly service: TerminalService) {}

  @RequirePermissions('MASTER_WRITE')
  @Post()
  @ApiOperation({ summary: '단말 등록' })
  @ApiResponse({ status: 400, description: '코드값 오류 · 설치 위치 지정 불완전' })
  @ApiResponse({ status: 409, description: '단말 코드 중복' })
  create(@Body() dto: CreateTerminalDto, @ActorId() actor?: bigint) {
    return this.service.create(dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get()
  @ApiOperation({ summary: '단말 목록 — 공장·유형·상태로 좁힐 수 있다' })
  findAll(@Query() query: TerminalQueryDto) {
    return this.service.findAll(query);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':terminalCode')
  @ApiOperation({ summary: '단말 단건 조회 (설치 위치·공정별 기능 매핑 포함)' })
  @ApiParam({ name: 'terminalCode', example: 'POP_INJ_01' })
  findOne(@Param('terminalCode') terminalCode: string) {
    return this.service.findOne(terminalCode);
  }

  @RequirePermissions('MASTER_WRITE')
  @Patch(':terminalCode')
  @ApiOperation({ summary: '단말 수정' })
  update(@Param('terminalCode') terminalCode: string, @Body() dto: UpdateTerminalDto, @ActorId() actor?: bigint) {
    return this.service.update(terminalCode, dto, actor);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':terminalCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '단말 비활성화' })
  deactivate(@Param('terminalCode') terminalCode: string, @ActorId() actor?: bigint) {
    return this.service.deactivate(terminalCode, actor);
  }

  @RequirePermissions('MASTER_WRITE')
  @Put(':terminalCode/processes')
  @ApiOperation({
    summary: '공정별 기능 매핑 저장 — 이미 있으면 기능 플래그를 덮어쓴다',
  })
  @ApiResponse({ status: 404, description: '단말·공정 없음' })
  upsertProcess(
    @Param('terminalCode') terminalCode: string,
    @Body() dto: UpsertTerminalProcessDto,
    @ActorId() actor?: bigint,
  ) {
    return this.service.upsertProcess(terminalCode, dto, actor);
  }

  @RequirePermissions('MASTER_READ')
  @Get(':terminalCode/processes')
  @ApiOperation({ summary: '공정별 기능 매핑 목록' })
  findProcesses(@Param('terminalCode') terminalCode: string) {
    return this.service.findProcesses(terminalCode);
  }

  @RequirePermissions('MASTER_DEACTIVATE')
  @Delete(':terminalCode/processes/:processCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '공정별 기능 매핑 해제 (단순 매핑이라 물리 삭제)' })
  removeProcess(
    @Param('terminalCode') terminalCode: string,
    @Param('processCode') processCode: string
  ) {
    return this.service.removeProcess(terminalCode, processCode);
  }
}
