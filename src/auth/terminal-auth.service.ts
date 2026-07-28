import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { terminal, worker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

/** 단말이 트랜잭션을 올릴 수 있는 유일한 상태. 점검중·폐기 단말은 거부한다. */
const USABLE_STATUS = 'NORMAL';

/** 사번이 실적에 귀속될 수 있는 유일한 재직 상태. */
const ACTIVE_WORKER_STATUS = 'ACTIVE';

const DEFAULT_TOKEN_DAYS = 365;

/**
 * mdm.terminal_process의 행위 플래그. POP의 인가는 역할·권한(RBAC)이 아니라
 * 이 (단말 × 공정) 매트릭스다 — 근거: 설계검토 §2.3
 */
export type TerminalCapability =
  | 'can_start_work'
  | 'can_complete_work'
  | 'can_input_material'
  | 'can_input_result'
  | 'can_input_inspection'
  | 'can_print_label'
  | 'can_cancel_input'
  | 'can_return_material';

export interface TerminalProcessCapability {
  processCode: string;
  processName: string;
  capabilities: TerminalCapability[];
}

export interface TerminalPrincipal {
  terminalId: bigint;
  terminalCode: string;
  plantId: bigint;
  processes: TerminalProcessCapability[];
}

export interface TerminalTokenResult {
  accessToken: string;
  expiresInSeconds: number;
  terminalCode: string;
}

/** 사람 토큰과 구분하는 클레임. 이 값이 없으면 사람 토큰으로 본다(기존 토큰 호환). */
export const TERMINAL_TOKEN_KIND = 'terminal';

const CAPABILITY_KEYS: TerminalCapability[] = [
  'can_start_work',
  'can_complete_work',
  'can_input_material',
  'can_input_result',
  'can_input_inspection',
  'can_print_label',
  'can_cancel_input',
  'can_return_material',
];

@Injectable()
export class TerminalAuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 단말 토큰 발급 — 관리 화면에서 단말 등록 시 1회 수행한다.
   *
   * 사람 토큰(8시간)과 달리 장기다. 현장에서 토큰이 만료되면 작업이 멈추고 그걸 푸는
   * 방법이 결국 '누군가 로그인'이라 REQ-PR-0023으로 되돌아가기 때문이다. 오프라인
   * 구간(결정 17)을 넘겨 outbox를 전송할 때도 살아 있어야 한다.
   * 통제는 만료가 아니라 폐기로 한다 — terminal.is_active=false 또는 status_code 전이.
   */
  async issueToken(terminalCode: string): Promise<TerminalTokenResult> {
    const found = await this.prisma.terminal.findUnique({
      where: { terminal_code: terminalCode },
    });
    if (!found) {
      throw new UnauthorizedException(`단말을 찾을 수 없습니다: ${terminalCode}`);
    }
    this.assertUsable(found);

    const days = this.config.get<number>('TERMINAL_TOKEN_EXPIRES_IN_DAYS', DEFAULT_TOKEN_DAYS);
    const expiresInSeconds = days * 24 * 60 * 60;

    const accessToken = await this.jwt.signAsync(
      {
        sub: found.terminal_id.toString(),
        kind: TERMINAL_TOKEN_KIND,
        terminalCode: found.terminal_code,
        plantId: found.plant_id.toString(),
      },
      { expiresIn: expiresInSeconds },
    );

    return { accessToken, expiresInSeconds, terminalCode: found.terminal_code };
  }

  /**
   * 토큰의 단말이 지금도 쓸 수 있는지 매 요청 확인한다.
   *
   * 캐시를 두면 조회는 줄지만 폐기 반영이 늦어진다. 분실 단말을 즉시 끊는 쪽이
   * 지금 단계에서 더 중요해 캐시 없이 간다 — 부하가 문제가 되면 그때 넣는다.
   */
  async resolvePrincipal(terminalId: bigint): Promise<TerminalPrincipal> {
    const found = await this.prisma.terminal.findUnique({
      where: { terminal_id: terminalId },
      include: {
        terminal_process: {
          include: { process: { select: { process_code: true, process_name: true } } },
        },
      },
    });
    if (!found) {
      throw new UnauthorizedException('등록되지 않은 단말입니다.');
    }
    this.assertUsable(found);

    return {
      terminalId: found.terminal_id,
      terminalCode: found.terminal_code,
      plantId: found.plant_id,
      processes: found.terminal_process.map((row) => ({
        processCode: row.process.process_code,
        processName: row.process.process_name,
        capabilities: CAPABILITY_KEYS.filter((key) => row[key]),
      })),
    };
  }

  /**
   * 사번 → 작업자. **인증이 아니라 귀속 확인이다.**
   * 존재·재직만 본다 — 공정 수행 자격(worker_qualification)까지 강제하면 자격 데이터가
   * 정비되기 전에 현장을 세운다. 자격 검증은 설정형으로 별도 도입한다(설계검토 §6-④).
   */
  async resolveWorker(workerNo: string): Promise<worker> {
    const found = await this.prisma.worker.findUnique({ where: { worker_no: workerNo } });
    if (!found) {
      throw new ForbiddenException(`등록되지 않은 사번입니다: ${workerNo}`);
    }
    if (!found.is_active || found.status_code !== ACTIVE_WORKER_STATUS) {
      throw new ForbiddenException(`재직 중이 아닌 사번입니다: ${workerNo}`);
    }
    return found;
  }

  /**
   * (단말 × 공정) 행위 허용 확인. 가드가 아니라 **서비스 계층에서** 부른다 —
   * 대상 공정은 대개 W/O·라우팅에서 파생돼 가드 시점에는 알 수 없다(설계검토 §6-①).
   */
  async assertCapability(
    terminalId: bigint,
    processCode: string,
    capability: TerminalCapability,
  ): Promise<void> {
    const row = await this.prisma.terminal_process.findFirst({
      where: { terminal_id: terminalId, process: { process_code: processCode } },
    });

    if (!row) {
      throw new ForbiddenException(`이 단말에 허용되지 않은 공정입니다: ${processCode}`);
    }
    if (!row[capability]) {
      throw new ForbiddenException(
        `이 단말은 ${processCode} 공정에서 ${capability} 행위가 허용되지 않았습니다.`,
      );
    }
  }

  private assertUsable(found: terminal): void {
    if (!found.is_active) {
      throw new UnauthorizedException(`사용 중지된 단말입니다: ${found.terminal_code}`);
    }
    if (found.status_code !== USABLE_STATUS) {
      throw new UnauthorizedException(
        `상태가 ${found.status_code}인 단말은 사용할 수 없습니다: ${found.terminal_code}`,
      );
    }
  }
}
