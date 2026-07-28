import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { terminal, worker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { TerminalAuthService, TERMINAL_TOKEN_KIND } from './terminal-auth.service';

const baseTerminal: terminal = {
  terminal_id: 5n,
  terminal_code: 'POP_INJ_01',
  plant_id: 2n,
  location_id: null,
  terminal_type_code: 'POP',
  status_code: 'NORMAL',
  is_active: true,
  token_version: 1,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

const baseWorker: worker = {
  worker_id: 30n,
  worker_no: 'EMP-1043',
  worker_name: '김작업',
  business_unit_id: 1n,
  plant_id: 2n,
  department_id: null,
  app_user_id: null,
  status_code: 'ACTIVE',
  is_active: true,
  created_at: new Date(),
  created_by: null,
  updated_at: new Date(),
  updated_by: null,
  version_no: 1,
};

describe('TerminalAuthService', () => {
  let service: TerminalAuthService;
  let prisma: {
    terminal: Record<string, jest.Mock>;
    terminal_process: Record<string, jest.Mock>;
    worker: Record<string, jest.Mock>;
  };
  const jwt = { signAsync: jest.fn() };
  const config = { get: jest.fn() };

  beforeEach(async () => {
    jwt.signAsync.mockResolvedValue('signed-token');
    config.get.mockImplementation((_key: string, fallback: number) => fallback);
    prisma = {
      terminal: { findUnique: jest.fn(), update: jest.fn() },
      terminal_process: { findFirst: jest.fn() },
      worker: { findUnique: jest.fn() },
    };
    // 발급은 세대를 올린 뒤 그 값으로 서명한다.
    prisma.terminal.update.mockImplementation(
      ({ where }: { where: { terminal_id: bigint } }) =>
        Promise.resolve({ ...baseTerminal, terminal_id: where.terminal_id, token_version: 2 }),
    );

    const moduleRef = await Test.createTestingModule({
      providers: [
        TerminalAuthService,
        { provide: PrismaService, useValue: prisma },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = moduleRef.get(TerminalAuthService);
  });

  describe('issueToken', () => {
    it('사람 토큰과 구분되도록 kind=terminal을 넣는다', async () => {
      prisma.terminal.findUnique.mockResolvedValue(baseTerminal);

      await service.issueToken('POP_INJ_01');

      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ sub: '5', kind: TERMINAL_TOKEN_KIND }),
        expect.anything(),
      );
    });

    // 현장에서 만료되면 작업이 멈추고 그걸 푸는 방법이 결국 로그인이라 장기로 둔다.
    it('기본 만료가 1년이다', async () => {
      prisma.terminal.findUnique.mockResolvedValue(baseTerminal);

      const result = await service.issueToken('POP_INJ_01');

      expect(result.expiresInSeconds).toBe(365 * 24 * 60 * 60);
    });

    it('없는 단말이면 401', async () => {
      prisma.terminal.findUnique.mockResolvedValue(null);

      await expect(service.issueToken('NOPE')).rejects.toThrow(UnauthorizedException);
    });

    it.each([
      ['비활성 단말', { ...baseTerminal, is_active: false }],
      ['점검중 단말', { ...baseTerminal, status_code: 'MAINTENANCE' }],
      ['폐기 단말', { ...baseTerminal, status_code: 'DISPOSED' }],
    ])('%s에는 발급하지 않는다', async (_label, row) => {
      prisma.terminal.findUnique.mockResolvedValue(row);

      await expect(service.issueToken('POP_INJ_01')).rejects.toThrow(UnauthorizedException);
    });

    // is_active는 스위치일 뿐이라 단말을 다시 켜면 유출 토큰도 되살아난다.
    // 폐기는 세대를 올려서 한다.
    it('발급할 때마다 세대를 올린다', async () => {
      prisma.terminal.findUnique.mockResolvedValue(baseTerminal);

      const result = await service.issueToken('POP_INJ_01');

      expect(prisma.terminal.update).toHaveBeenCalledWith({
        where: { terminal_id: 5n },
        data: { token_version: { increment: 1 } },
      });
      expect(result.tokenVersion).toBe(2);
    });

    it('올라간 세대를 tv 클레임에 담는다', async () => {
      prisma.terminal.findUnique.mockResolvedValue(baseTerminal);

      await service.issueToken('POP_INJ_01');

      expect(jwt.signAsync).toHaveBeenCalledWith(
        expect.objectContaining({ tv: 2 }),
        expect.anything(),
      );
    });

    it('발급 불가 단말에는 세대를 올리지 않는다', async () => {
      prisma.terminal.findUnique.mockResolvedValue({ ...baseTerminal, is_active: false });

      await expect(service.issueToken('POP_INJ_01')).rejects.toThrow(UnauthorizedException);
      expect(prisma.terminal.update).not.toHaveBeenCalled();
    });
  });

  describe('resolvePrincipal', () => {
    it('공정별로 켜진 행위 플래그만 추린다', async () => {
      prisma.terminal.findUnique.mockResolvedValue({
        ...baseTerminal,
        terminal_process: [
          {
            can_start_work: true,
            can_complete_work: false,
            can_input_material: true,
            can_input_result: false,
            can_input_inspection: false,
            can_print_label: false,
            can_cancel_input: false,
            can_return_material: false,
            process: { process_code: 'MOLDING', process_name: '사출' },
          },
        ],
      });

      const principal = await service.resolvePrincipal(5n, 1);

      expect(principal.processes).toEqual([
        {
          processCode: 'MOLDING',
          processName: '사출',
          capabilities: ['can_start_work', 'can_input_material'],
        },
      ]);
    });

    // 캐시를 두지 않으므로 폐기가 다음 요청에서 바로 걸린다.
    it('폐기된 단말의 토큰은 더 이상 통하지 않는다', async () => {
      prisma.terminal.findUnique.mockResolvedValue({
        ...baseTerminal,
        is_active: false,
        terminal_process: [],
      });

      await expect(service.resolvePrincipal(5n, 1)).rejects.toThrow(UnauthorizedException);
    });

    // 재발급으로 세대가 2로 올라간 뒤, 세대 1로 서명된 구 토큰이 오는 상황.
    it('구 세대 토큰은 거부한다', async () => {
      prisma.terminal.findUnique.mockResolvedValue({
        ...baseTerminal,
        token_version: 2,
        terminal_process: [],
      });

      await expect(service.resolvePrincipal(5n, 1)).rejects.toThrow(
        '재발급으로 폐기된 토큰입니다. 단말에 최신 토큰을 다시 주입하십시오.',
      );
    });

    it('현 세대 토큰은 통과한다', async () => {
      prisma.terminal.findUnique.mockResolvedValue({
        ...baseTerminal,
        token_version: 2,
        terminal_process: [],
      });

      await expect(service.resolvePrincipal(5n, 2)).resolves.toMatchObject({
        terminalCode: 'POP_INJ_01',
      });
    });
  });

  describe('resolveWorker', () => {
    it('존재·재직이면 통과한다', async () => {
      prisma.worker.findUnique.mockResolvedValue(baseWorker);

      await expect(service.resolveWorker('EMP-1043')).resolves.toMatchObject({
        worker_no: 'EMP-1043',
      });
    });

    it('없는 사번이면 403', async () => {
      prisma.worker.findUnique.mockResolvedValue(null);

      await expect(service.resolveWorker('EMP-9999')).rejects.toThrow(ForbiddenException);
    });

    it.each([
      ['퇴사자', { ...baseWorker, status_code: 'RESIGNED' }],
      ['비활성', { ...baseWorker, is_active: false }],
    ])('%s 사번이면 403', async (_label, row) => {
      prisma.worker.findUnique.mockResolvedValue(row);

      await expect(service.resolveWorker('EMP-1043')).rejects.toThrow(ForbiddenException);
    });

    // 자격 검증은 설정형으로 별도 도입한다(설계검토 §6-④) — 지금은 보지 않는다.
    it('공정 수행 자격은 확인하지 않는다', async () => {
      prisma.worker.findUnique.mockResolvedValue(baseWorker);

      await service.resolveWorker('EMP-1043');

      expect(prisma.worker.findUnique).toHaveBeenCalledWith({
        where: { worker_no: 'EMP-1043' },
      });
    });
  });

  describe('assertCapability', () => {
    it('매핑되지 않은 공정이면 403', async () => {
      prisma.terminal_process.findFirst.mockResolvedValue(null);

      await expect(service.assertCapability(5n, 'ASSEMBLY', 'can_input_result')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('플래그가 꺼져 있으면 403', async () => {
      prisma.terminal_process.findFirst.mockResolvedValue({ can_input_result: false });

      await expect(service.assertCapability(5n, 'MOLDING', 'can_input_result')).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('플래그가 켜져 있으면 통과한다', async () => {
      prisma.terminal_process.findFirst.mockResolvedValue({ can_input_result: true });

      await expect(
        service.assertCapability(5n, 'MOLDING', 'can_input_result'),
      ).resolves.toBeUndefined();
    });
  });
});
