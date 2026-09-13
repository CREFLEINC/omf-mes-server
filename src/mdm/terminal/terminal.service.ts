import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';

import { TOKEN_TYPE } from '../../auth/session-resolver.service';
import type { TerminalContext } from '../../auth/terminal-context';
import { ContractException, ERROR_CODE } from '../../common/errors';
import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ReferenceQuery,
  assertCodeValues,
  optional,
  referencePage,
  referenceWhere,
} from '../../common/master';

/** 계약 `Terminal` 과 동형. 설비 코드·명을 함께 실어 왕복 한 번을 없앤다(계약). */
interface TerminalView {
  terminalId: number;
  terminalCode: string;
  plantId: number;
  /** ⛔ 비면 «칸을 뺀다». 계약이 「비어 있을 수 있다」로 적고도 타입을 nullable 로 두지
   * 않았다(`type: integer`) — null 을 실으면 응답이 계약을 어긴다. 되돌림 문서에 적었다. */
  locationId?: number;
  equipmentId: number | null;
  equipmentCode: string | null;
  equipmentName: string | null;
  terminalTypeCode: string;
  statusCode: string;
  isActive: boolean;
  tokenIssuedAt?: string;
  tokenVersion: number;
  registrationStatusCode: 'UNREGISTERED' | 'REGISTERED';
  registrationConfirmedAt: string | null;
  versionNo: number;
}

/** 계약 `TerminalProcess` — 「인증이 아니라 기능 구성」이다(P-CO-01 §5-1). */
interface TerminalProcessView {
  processId: number;
  processName: string;
  canStartWork: boolean;
  canCompleteWork: boolean;
  canInputMaterial: boolean;
  canInputResult: boolean;
  canInputInspection: boolean;
  canPrintLabel: boolean;
  canCancelInput: boolean;
  canReturnMaterial: boolean;
}

export interface TerminalProcessInput {
  processId: number;
  canStartWork?: boolean;
  canCompleteWork?: boolean;
  canInputMaterial?: boolean;
  canInputResult?: boolean;
  canInputInspection?: boolean;
  canPrintLabel?: boolean;
  canCancelInput?: boolean;
  canReturnMaterial?: boolean;
}

export interface TerminalCreate {
  terminalCode: string;
  plantId: number;
  locationId?: number | null;
  equipmentId?: number | null;
  terminalTypeCode: string;
  statusCode: string;
}

export interface TerminalUpdate {
  plantId: number;
  locationId?: number | null;
  equipmentId?: number | null;
  terminalTypeCode: string;
  statusCode: string;
}

export interface TerminalQuery extends ReferenceQuery {
  plantId?: number;
  terminalTypeCode?: string;
}

export interface RegistrationToken {
  terminalId: number;
  token: string;
  issuedAt: string;
  expiresAt: string;
}

export interface RegistrationConfirmation {
  terminalId: number;
  tokenVersion: number;
  registrationStatusCode: 'REGISTERED';
  registrationConfirmedAt: string;
}

type TerminalRow = Prisma.terminalGetPayload<{
  include: { equipment: { select: { equipment_code: true; equipment_name: true } } };
}>;

const WITH_EQUIPMENT = {
  equipment: { select: { equipment_code: true, equipment_name: true } },
} as const;

/** 「만료 1년」(계약 `TerminalRegistrationToken.expiresAt`). */
const TOKEN_TTL_SECONDS = 365 * 24 * 60 * 60;

@Injectable()
export class TerminalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async list(query: TerminalQuery): Promise<PagedResponse<TerminalView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'terminal_code', name: 'terminal_code' }, {
      ...optional('plant_id', query.plantId),
      ...optional('terminal_type_code', query.terminalTypeCode),
    });
    const [rows, total] = await Promise.all([
      this.prisma.terminal.findMany({
        where,
        include: WITH_EQUIPMENT,
        orderBy: { terminal_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.terminal.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  async get(terminalId: number): Promise<{ terminal: TerminalView; versionNo: number }> {
    const row = await this.prisma.terminal.findUnique({
      where: { terminal_id: terminalId },
      include: WITH_EQUIPMENT,
    });
    if (!row) throw new NotFoundException('없는 단말입니다.');
    return { terminal: view(row), versionNo: row.version_no };
  }

  async create(input: TerminalCreate): Promise<TerminalView> {
    await this.assertCodes(input);
    const created = await this.prisma.terminal.create({
      data: {
        terminal_code: input.terminalCode,
        plant_id: input.plantId,
        terminal_type_code: input.terminalTypeCode,
        status_code: input.statusCode,
        ...optional('location_id', input.locationId),
        ...optional('equipment_id', input.equipmentId),
      },
      include: WITH_EQUIPMENT,
    });
    return view(created);
  }

  /** ⛔ `terminalCode` 는 본문에 자리가 없다 — 「설치 후에는 바꾸지 않는다. 키다」(계약). */
  async update(
    terminalId: number,
    version: number,
    input: TerminalUpdate,
  ): Promise<{ terminal: TerminalView; versionNo: number }> {
    await this.assertCodes(input);
    const updated = await this.prisma.terminal.updateMany({
      // ⛔ version_no 를 조건에 건다. 0행이면 그 사이 누가 먼저 저장했다.
      where: { terminal_id: terminalId, version_no: version },
      data: {
        plant_id: input.plantId,
        terminal_type_code: input.terminalTypeCode,
        status_code: input.statusCode,
        ...optional('location_id', input.locationId),
        ...optional('equipment_id', input.equipmentId),
        version_no: { increment: 1 },
      },
    });
    await this.assertExists(terminalId, updated.count);
    return this.get(terminalId);
  }

  /** 「지우지 않고 끈다 — 그 단말이 남긴 기록이 참조로 남아 있다」(계약). */
  async deactivate(
    terminalId: number,
    version: number,
  ): Promise<{ terminal: TerminalView; versionNo: number }> {
    const updated = await this.prisma.terminal.updateMany({
      where: { terminal_id: terminalId, version_no: version },
      data: { is_active: false, version_no: { increment: 1 } },
    });
    await this.assertExists(terminalId, updated.count);
    return this.get(terminalId);
  }

  /**
   * 기기에 넣을 등록 토큰을 낸다.
   *
   * ⭐ 관리웹이 받아 **QR 로 그려** 보이고 기기가 읽는다. FR-007 등록 완료 확인은
   * 이 토큰을 Bearer 로 제시한 기기만 호출한다(P-7); 토큰 없이 열리는 경로는 없다.
   *
   * ⛔ 발급마다 `token_version` 을 올린다. 이전 기기의 토큰은 클레임 `tv` 가 어긋나
   * 거부된다 — 「재발급하면 이전 기기 전부가 끊긴다」(공유계약 F-4). 화면이 그 사실을
   * 미리 안내한다.
   */
  async issueToken(terminalId: number): Promise<RegistrationToken> {
    const issuedAt = new Date();
    const updated = await this.prisma.terminal.updateMany({
      where: { terminal_id: terminalId },
      data: { token_version: { increment: 1 }, token_issued_at: issuedAt,
        version_no: { increment: 1 } },
    });
    if (updated.count === 0) throw new NotFoundException('없는 단말입니다.');

    const row = await this.prisma.terminal.findUniqueOrThrow({
      where: { terminal_id: terminalId },
      select: { token_version: true, terminal_code: true, plant_id: true },
    });
    const token = await this.jwt.signAsync(
      // ⛔ 종류를 담는다. 세션 쿠키와 «같은 비밀키»로 서명하므로, 종류가 없으면 이 토큰을
      // 쿠키로 들이밀었을 때 sub(단말 번호)가 같은 번호의 사용자로 풀린다.
      { sub: terminalId, typ: TOKEN_TYPE.TERMINAL, tv: row.token_version,
        terminalCode: row.terminal_code, plantId: Number(row.plant_id) },
      { expiresIn: TOKEN_TTL_SECONDS },
    );

    return {
      terminalId,
      token,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + TOKEN_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** Mark only the currently authenticated MOBILE token generation as registered. */
  async confirmRegistration(
    terminalId: number,
    terminal: TerminalContext,
  ): Promise<RegistrationConfirmation> {
    if (terminal.terminalId !== BigInt(terminalId) || terminal.terminalTypeCode !== 'MOBILE'
      || terminal.tokenVersion === undefined) throw registrationDenied();

    // The token can be reissued between the auth guard and this write. The
    // guarded UPDATE closes that race; retries preserve the original timestamp.
    const rows = await this.prisma.$queryRaw<{
      terminal_id: bigint; token_version: number; registration_confirmed_at: Date;
    }[]>(Prisma.sql`
      UPDATE mdm.terminal
      SET registered_token_version = token_version,
          registration_confirmed_at = CASE
            WHEN registered_token_version = token_version
              AND registration_confirmed_at IS NOT NULL THEN registration_confirmed_at
            ELSE clock_timestamp()
          END,
          version_no = version_no + CASE
            WHEN registered_token_version = token_version
              AND registration_confirmed_at IS NOT NULL THEN 0
            ELSE 1
          END
      WHERE terminal_id = ${terminal.terminalId}
        AND terminal_code = ${terminal.terminalCode}
        AND plant_id = ${terminal.plantId}
        AND terminal_type_code = 'MOBILE'
        AND token_version = ${terminal.tokenVersion}
        AND token_issued_at IS NOT NULL
        AND is_active = true
      RETURNING terminal_id, token_version, registration_confirmed_at
    `);
    const row = rows[0];
    if (!row) throw registrationDenied();
    return {
      terminalId: Number(row.terminal_id),
      tokenVersion: row.token_version,
      registrationStatusCode: 'REGISTERED',
      registrationConfirmedAt: row.registration_confirmed_at.toISOString(),
    };
  }

  // ── 공정 구성 ───────────────────────────────────────────────────────────

  async listProcesses(
    terminalId: number,
  ): Promise<{ items: TerminalProcessView[]; versionNo: number }> {
    const { versionNo } = await this.get(terminalId);
    return { items: await this.readProcesses(terminalId), versionNo };
  }

  /**
   * 「단말 하나의 공정 구성을 통째로 바꾼다 — 화면의 저장이 단말 단위 한 트랜잭션이다.
   * 빠진 공정은 지워진다」(계약).
   *
   * 잠금 축은 단말의 `version_no` 다 — `terminal_process` 에 자기 버전이 없다.
   */
  async replaceProcesses(
    terminalId: number,
    version: number,
    items: TerminalProcessInput[],
    appUserId?: number,
  ): Promise<{ items: TerminalProcessView[]; versionNo: number }> {
    assertProcesses(items);

    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.terminal.updateMany({
        where: { terminal_id: terminalId, version_no: version },
        data: { version_no: { increment: 1 } },
      });
      if (bumped.count === 0) {
        const exists = await tx.terminal.findUnique({
          where: { terminal_id: terminalId },
          select: { terminal_id: true },
        });
        if (!exists) throw new NotFoundException('없는 단말입니다.');
        assertUpdated(0);
      }

      await tx.terminal_process.deleteMany({ where: { terminal_id: terminalId } });
      if (items.length === 0) return;
      await tx.terminal_process.createMany({
        data: items.map((item) => ({
          terminal_id: terminalId,
          process_id: item.processId,
          // 기본은 «닫힘»이다(계약). 안 보낸 권한은 열지 않는다.
          can_start_work: item.canStartWork ?? false,
          can_complete_work: item.canCompleteWork ?? false,
          can_input_material: item.canInputMaterial ?? false,
          can_input_result: item.canInputResult ?? false,
          can_input_inspection: item.canInputInspection ?? false,
          can_print_label: item.canPrintLabel ?? false,
          can_cancel_input: item.canCancelInput ?? false,
          can_return_material: item.canReturnMaterial ?? false,
          ...(appUserId === undefined ? {} : { created_by: appUserId }),
        })),
      });
    });

    return this.listProcesses(terminalId);
  }

  private async readProcesses(terminalId: number): Promise<TerminalProcessView[]> {
    const rows = await this.prisma.terminal_process.findMany({
      where: { terminal_id: terminalId },
      include: { process: { select: { process_name: true } } },
      orderBy: { process_id: 'asc' },
    });
    return rows.map((row) => ({
      processId: Number(row.process_id),
      processName: row.process.process_name,
      canStartWork: row.can_start_work,
      canCompleteWork: row.can_complete_work,
      canInputMaterial: row.can_input_material,
      canInputResult: row.can_input_result,
      canInputInspection: row.can_input_inspection,
      canPrintLabel: row.can_print_label,
      canCancelInput: row.can_cancel_input,
      canReturnMaterial: row.can_return_material,
    }));
  }

  /** 두 그룹 다 시스템 소유다 — 계약이 enum 을 안 적고 코드 그룹으로 부르므로 여기서 거른다. */
  private assertCodes(input: { terminalTypeCode: string; statusCode: string }): Promise<void> {
    return assertCodeValues(this.prisma, [
      { field: 'terminalTypeCode', value: input.terminalTypeCode, groupCode: 'TERMINAL_TYPE' },
      { field: 'statusCode', value: input.statusCode, groupCode: 'TERMINAL_STATUS' },
    ]);
  }

  /** 0행이 「없다」인지 「낡았다」인지 가른다 — 화면이 받는 상태 코드가 갈린다. */
  private async assertExists(terminalId: number, count: number): Promise<void> {
    if (count > 0) return;
    const exists = await this.prisma.terminal.findUnique({
      where: { terminal_id: terminalId },
      select: { terminal_id: true },
    });
    if (!exists) throw new NotFoundException('없는 단말입니다.');
    assertUpdated(0);
  }
}

/** `uq_terminal_process` — 같은 공정이 두 줄이면 어느 줄인지 짚는다. */
function assertProcesses(items: TerminalProcessInput[]): void {
  const seen = new Map<number, number>();
  const errors = items.flatMap((item, index) => {
    const first = seen.get(item.processId);
    if (first === undefined) {
      seen.set(item.processId, index);
      return [];
    }
    return [
      {
        scope: 'field' as const,
        field: `items[${index}].processId`,
        code: ERROR_CODE.UNIQUE_VIOLATION,
        uniqueScope: ['processId'],
        message: `${first + 1}번째 줄과 같은 공정입니다.`,
      },
    ];
  });
  if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
}

function view(row: TerminalRow): TerminalView {
  const registered = row.registered_token_version === row.token_version
    && row.registration_confirmed_at !== null;
  return {
    terminalId: Number(row.terminal_id),
    terminalCode: row.terminal_code,
    plantId: Number(row.plant_id),
    ...(row.location_id === null ? {} : { locationId: Number(row.location_id) }),
    equipmentId: row.equipment_id === null ? null : Number(row.equipment_id),
    equipmentCode: row.equipment?.equipment_code ?? null,
    equipmentName: row.equipment?.equipment_name ?? null,
    terminalTypeCode: row.terminal_type_code,
    statusCode: row.status_code,
    isActive: row.is_active,
    ...(row.token_issued_at === null
      ? {}
      : { tokenIssuedAt: row.token_issued_at.toISOString() }),
    tokenVersion: row.token_version,
    registrationStatusCode: registered ? 'REGISTERED' : 'UNREGISTERED',
    registrationConfirmedAt: registered ? row.registration_confirmed_at?.toISOString() ?? null : null,
    versionNo: row.version_no,
  };
}

function registrationDenied(): ContractException {
  return new ContractException(HttpStatus.UNAUTHORIZED, [
    { scope: 'screen', code: ERROR_CODE.PERMISSION_DENIED,
      message: '단말 등록 토큰이 유효하지 않습니다.' },
  ]);
}
