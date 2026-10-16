import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';

import { ContractException, ERROR_CODE, ErrorItem } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';

/** 계정에 연결된 작업자 — 연결이 없으면 세 칸이 모두 `null` 이다(장부 P-38). */
export interface UserWorkerLink {
  workerId: number | null;
  workerNo: string | null;
  workerName: string | null;
}

const NONE: UserWorkerLink = { workerId: null, workerNo: null, workerName: null };

/**
 * 관리웹 계정 ↔ 작업자(사번) 연결(omf-all-around#104 · 2026-10-16 결정 ①). 물리는 이미 있다 —
 * `mdm.worker.app_user_id`. 연결 편집 화면이 없어 DB 에 직접 넣어 왔고, 그 결과 관리웹 IQC 판정이
 * 「검사자를 풀 수 없습니다」로 막혔다(`inspection-result-write-rules.ts` `resolveInspector`).
 *
 * ⭐ **한 작업자 = 한 계정 · 한 계정 = 한 작업자.** 칸에 유일 제약이 없어 여기서 지킨다 — 둘 이상이면
 *    `resolveInspector` 의 `findFirst` 가 임의의 작업자를 검사자로 남긴다.
 * ⚠ 운영 DB 에 이미 중복이 있는지는 확인하지 않았다(장부 P-38 의 확인 SQL).
 */
@Injectable()
export class UserWorkerLinkService {
  constructor(private readonly prisma: PrismaService) {}

  async get(appUserId: number): Promise<UserWorkerLink> {
    await this.assertUser(appUserId);
    return linkOf(
      await this.prisma.worker.findFirst({
        where: { app_user_id: BigInt(appUserId) },
        orderBy: { worker_id: 'asc' },
        select: { worker_id: true, worker_no: true, worker_name: true },
      }),
    );
  }

  async replace(appUserId: number, workerId: number | null, actorId?: number): Promise<UserWorkerLink> {
    await this.assertUser(appUserId);
    const by = actorId === undefined ? null : BigInt(actorId);
    await this.prisma.$transaction(async (tx) => {
      if (workerId !== null) {
        const worker = await tx.worker.findUnique({
          where: { worker_id: BigInt(workerId) },
          select: { is_active: true, app_user_id: true },
        });
        if (worker === null) throw invalid('없는 작업자입니다.');
        if (!worker.is_active) throw invalid('사용하지 않는 작업자는 연결할 수 없습니다.');
        if (worker.app_user_id !== null && worker.app_user_id !== BigInt(appUserId)) {
          throw invalid('이미 다른 계정에 연결된 작업자입니다.');
        }
      }
      // 계정 하나에 작업자 하나 — 앞의 연결을 먼저 푼다(대상 작업자 자신은 제외해 버전을 헛돌리지 않는다).
      await tx.worker.updateMany({
        where: {
          app_user_id: BigInt(appUserId),
          ...(workerId === null ? {} : { worker_id: { not: BigInt(workerId) } }),
        },
        data: { app_user_id: null, updated_by: by, version_no: { increment: 1 } },
      });
      if (workerId !== null) {
        await tx.worker.updateMany({
          where: { worker_id: BigInt(workerId), app_user_id: null },
          data: { app_user_id: BigInt(appUserId), updated_by: by, version_no: { increment: 1 } },
        });
      }
    });
    return this.get(appUserId);
  }

  private async assertUser(appUserId: number): Promise<void> {
    const row = await this.prisma.app_user.findUnique({
      where: { app_user_id: BigInt(appUserId) },
      select: { app_user_id: true },
    });
    if (!row) throw new NotFoundException('없는 사용자입니다.');
  }
}

export function linkOf(row: { worker_id: bigint; worker_no: string; worker_name: string } | null): UserWorkerLink {
  return row === null
    ? NONE
    : { workerId: Number(row.worker_id), workerNo: row.worker_no, workerName: row.worker_name };
}

function invalid(message: string): ContractException {
  const item: ErrorItem = { scope: 'field', field: 'workerId', code: ERROR_CODE.INVALID, message };
  return new ContractException(HttpStatus.BAD_REQUEST, [item]);
}
