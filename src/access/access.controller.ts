import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';

import { ActorId } from '../auth/auth.decorators';
import { SetPasswordDto } from '../auth/auth.dto';
import { AuthService } from '../auth/auth.service';
import { PageQueryDto } from '../common/dto/page-query.dto';
import {
  AddDataScopeDto,
  AddPermissionDto,
  AssignRoleDto,
  CreateRoleDto,
  CreateUserDto,
  UpdateRoleDto,
  UpdateUserDto,
  UserQueryDto,
} from './access.dto';
import { RoleService } from './role.service';
import { UserService } from './user.service';

@ApiTags('접근권한 — 역할')
@Controller('access/roles')
export class RoleController {
  constructor(private readonly service: RoleService) {}

  @Post()
  @ApiOperation({ summary: '역할 등록' })
  @ApiResponse({ status: 409, description: '역할 코드 중복' })
  create(@Body() dto: CreateRoleDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: '역할 목록' })
  findAll(@Query() query: PageQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':roleCode')
  @ApiOperation({ summary: '역할 단건 조회 (기능권한 포함)' })
  @ApiParam({ name: 'roleCode', example: 'PROD_MANAGER' })
  findOne(@Param('roleCode') roleCode: string) {
    return this.service.findOne(roleCode);
  }

  @Patch(':roleCode')
  @ApiOperation({ summary: '역할 수정' })
  update(@Param('roleCode') roleCode: string, @Body() dto: UpdateRoleDto) {
    return this.service.update(roleCode, dto);
  }

  @Delete(':roleCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '역할 비활성화' })
  @ApiResponse({ status: 409, description: '역할을 가진 사용자가 있음' })
  deactivate(@Param('roleCode') roleCode: string) {
    return this.service.deactivate(roleCode);
  }

  @Post(':roleCode/permissions')
  @ApiOperation({ summary: '기능권한 부여' })
  @ApiResponse({ status: 400, description: '권한 코드값 오류' })
  @ApiResponse({ status: 409, description: '이미 부여된 권한' })
  addPermission(@Param('roleCode') roleCode: string, @Body() dto: AddPermissionDto) {
    return this.service.addPermission(roleCode, dto);
  }

  @Get(':roleCode/permissions')
  @ApiOperation({ summary: '기능권한 목록' })
  findPermissions(@Param('roleCode') roleCode: string) {
    return this.service.findPermissions(roleCode);
  }

  @Delete(':roleCode/permissions/:permissionCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '기능권한 회수' })
  removePermission(
    @Param('roleCode') roleCode: string,
    @Param('permissionCode') permissionCode: string,
  ) {
    return this.service.removePermission(roleCode, permissionCode);
  }
}

@ApiTags('접근권한 — 사용자')
@Controller('access/users')
export class UserController {
  constructor(
    private readonly service: UserService,
    private readonly auth: AuthService,
  ) {}

  @Put(':loginId/password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: '비밀번호 발급·재발급 — 다음 로그인에서 변경을 강제한다',
  })
  async setPassword(
    @Param('loginId') loginId: string,
    @Body() dto: SetPasswordDto,
    @ActorId() actor?: bigint,
  ) {
    const user = await this.service.findOne(loginId);
    await this.auth.setPassword(user.app_user_id, dto.password, actor);
  }

  @Post()
  @ApiOperation({ summary: '사용자 계정 등록 — 로그인 자격증명은 다루지 않는다' })
  @ApiResponse({ status: 409, description: '로그인 ID 중복' })
  create(@Body() dto: CreateUserDto) {
    return this.service.create(dto);
  }

  @Get()
  @ApiOperation({ summary: '사용자 목록 — 상태·역할로 좁힐 수 있다' })
  findAll(@Query() query: UserQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':loginId')
  @ApiOperation({ summary: '사용자 단건 조회 (부서·역할·접근범위 포함)' })
  @ApiParam({ name: 'loginId', example: 'hong.gildong' })
  findOne(@Param('loginId') loginId: string) {
    return this.service.findOne(loginId);
  }

  @Patch(':loginId')
  @ApiOperation({ summary: '사용자 수정' })
  update(@Param('loginId') loginId: string, @Body() dto: UpdateUserDto) {
    return this.service.update(loginId, dto);
  }

  @Delete(':loginId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '사용자 비활성화 (역할·접근범위는 보존)' })
  deactivate(@Param('loginId') loginId: string) {
    return this.service.deactivate(loginId);
  }

  // ── 역할 배정 ─────────────────────────────────────────────────────────

  @Post(':loginId/roles')
  @ApiOperation({ summary: '역할 부여' })
  @ApiResponse({ status: 400, description: '비활성 역할' })
  @ApiResponse({ status: 409, description: '이미 부여된 역할' })
  assignRole(@Param('loginId') loginId: string, @Body() dto: AssignRoleDto) {
    return this.service.assignRole(loginId, dto);
  }

  @Get(':loginId/roles')
  @ApiOperation({ summary: '부여된 역할 목록' })
  findRoles(@Param('loginId') loginId: string) {
    return this.service.findRoles(loginId);
  }

  @Delete(':loginId/roles/:roleCode')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '역할 회수' })
  revokeRole(@Param('loginId') loginId: string, @Param('roleCode') roleCode: string) {
    return this.service.revokeRole(loginId, roleCode);
  }

  @Get(':loginId/permissions')
  @ApiOperation({
    summary: '유효 기능권한 — 역할 경유로 모아 준다. 비활성 역할의 권한은 제외',
  })
  findPermissions(@Param('loginId') loginId: string) {
    return this.service.findEffectivePermissions(loginId);
  }

  // ── 데이터 접근범위 ───────────────────────────────────────────────────

  @Post(':loginId/data-scopes')
  @ApiOperation({ summary: '데이터 접근범위 부여 — 사업부·공장 중 최소 하나' })
  @ApiResponse({ status: 400, description: '대상 미지정 · 법인 미지정' })
  @ApiResponse({ status: 409, description: '이미 부여된 접근범위' })
  addDataScope(@Param('loginId') loginId: string, @Body() dto: AddDataScopeDto) {
    return this.service.addDataScope(loginId, dto);
  }

  @Get(':loginId/data-scopes')
  @ApiOperation({ summary: '데이터 접근범위 목록' })
  findDataScopes(@Param('loginId') loginId: string) {
    return this.service.findDataScopes(loginId);
  }

  @Delete(':loginId/data-scopes/:scopeId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '데이터 접근범위 회수' })
  removeDataScope(
    @Param('loginId') loginId: string,
    @Param('scopeId', ParseIntPipe) scopeId: number,
  ) {
    return this.service.removeDataScope(loginId, BigInt(scopeId));
  }
}
