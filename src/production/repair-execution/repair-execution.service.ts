import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { ConflictException, ContractException, ERROR_CODE, ErrorItem, field } from '../../common/errors';
import { assertWorkerNoExists } from '../../common/master';
import { PrismaService } from '../../prisma/prisma.service';
// ⛔ 새 사본을 만들지 않는다 — 같은 도메인의 것을 그대로 쓴다(I-25 R-6 · 공용화는 #337 몫).
//    PR ② 가 같은 자리에서 이 import 로 선례를 세웠다.
import { RepairExecutionView, repairExecutionView } from './repair-execution-view';

/** 계약 `RepairExecutionCreate` — required 4 · `repairProcessId` 만 선택이고 널을 허용한다(§1-3). */
export interface RepairExecutionCreate {
  defectRecordId: number;
  repairProcessId?: number | null;
  startedAt: string;
  repairQty: number;
  uomId: number;
}

/** 본문 «밖»에서 오는 것. 계약이 ⌜사번은 `X-Worker-No` 헤더 · 단말은 서버가 토큰에서 푼다⌝ 라 적었다. */
export interface RepairExecutionContext {
  workerNo: string | undefined;
  appUserId: number | undefined;
  terminalId: bigint | null;
}

/**
 * 수리 투입 등록 — 구간을 «연다»(I-25 §5). 반출은 `repair-execution-return.service.ts` 가 닫는다.
 *
 * ⛔ **원장 0 · 상태기계 0**(§8-2 · R-3) — `repair_execution` 에 상태 칸 자체가 없고 구간을
 *    `returned_at` 의 유무로 판정한다. `document-post`·`transitions.ts` 를 지나지 않는다.
 * ⛔ `defect_record` 를 **갱신하지 않는다** — 계약 x-internal-note 가 ⌜기록 전용이라 이쪽을
 *    갱신하지 않고 여기에 쌓는다⌝ 로 못박았다. 읽기만 한다(다른 도메인 service 호출 0).
 * ⛔ `reintroduced_lot_id` 를 채우지 않는다 — 이 값을 실을 쓰기가 계약에 없다(§0 자리 4).
 */
@Injectable()
export class RepairExecutionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(body: RepairExecutionCreate, context: RepairExecutionContext): Promise<RepairExecutionView> {
    await assertWorkerNoExists(this.prisma, context.workerNo);
    await this.assertCreatable(body);
    return this.prisma.$transaction((tx) => this.write(tx, body, context));
  }

  /** §5 ⑤~⑥ — 열린 건 판정 → INSERT. */
  private async write(
    tx: Prisma.TransactionClient,
    body: RepairExecutionCreate,
    context: RepairExecutionContext,
  ): Promise<RepairExecutionView> {
    const defectRecordId = BigInt(body.defectRecordId);
    // ⭐ 구간형이라 «상태»가 아니라 열린 행의 유무로 판정한다. ⛔ `FOR UPDATE` 를 쓰지 않는다 —
    //    잠글 부모가 없고(`defect_record` 는 기록 전용) 부분 UNIQUE 는 마이그다(§5-2 · 통보 161).
    const open = await tx.repair_execution.findFirst({
      where: { defect_record_id: defectRecordId, returned_at: null },
      select: { repair_execution_id: true },
    });
    if (open !== null) {
      throw new ConflictException('user', '이 불량에 열린 수리 건이 이미 있습니다.', {
        code: ERROR_CODE.OPEN_SESSION_EXISTS,
      });
    }
    const row = await tx.repair_execution.create({
      data: {
        defect_record_id: defectRecordId,
        repair_process_id: nullableId(body.repairProcessId),
        started_at: new Date(body.startedAt),
        repair_qty: body.repairQty,
        uom_id: BigInt(body.uomId),
        // ⛔ `returned_at`·`repair_result_code`·`reintroduced_lot_id` 셋 다 NULL 로 태어난다 —
        //    앞의 둘은 CHECK `ck_repair_execution_return` 이 «함께» 쓰라고 건 짝이다.
        // 헤더 문자를 그대로 옮겨 적는다(계약 ⌜투입한 사람⌝ · `:return` 이 덮지 않는다 · §6-1).
        worker_no: context.workerNo,
        terminal_id: context.terminalId,
        created_by: context.appUserId,
      },
    });
    return repairExecutionView(row);
  }

  /**
   * 트랜잭션 «밖»의 검증(§5 ②~③). ⛔ 단말 게이팅(`terminal_process`)을 걸지 않는다 —
   * 계약이 이 자리에 `can_*` 를 안 적었다(I-11 R-5 와 같은 판정 · 403 은 `PermissionGuard` 뿐).
   */
  private async assertCreatable(body: RepairExecutionCreate): Promise<void> {
    const errors: ErrorItem[] = [];
    // CHECK `ck_repair_execution_qty` 앞당김 — 위반이 `PrismaClientUnknownRequestError` 라
    // 공용 그물에 안 걸려 500 으로 샌다(§2).
    if (!(body.repairQty > 0)) {
      errors.push(field('repairQty', ERROR_CODE.RANGE, '수리 수량은 0보다 커야 합니다.'));
    }
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);

    // ⭐ 참조 셋을 «전수» 본다 — 하나라도 빠지면 FK 가 터져 운영에서 500 이 샌다(#440 Minor-1).
    const processId = nullableId(body.repairProcessId);
    const [defects, uoms, processes] = await Promise.all([
      this.prisma.defect_record.count({ where: { defect_record_id: BigInt(body.defectRecordId) } }),
      this.prisma.uom.count({ where: { uom_id: BigInt(body.uomId) } }),
      processId === null ? Promise.resolve(1) : this.prisma.process.count({ where: { process_id: processId } }),
    ]);
    // 계약이 이 경로에 404 를 선언하지 않았다 — 없는 참조는 전부 400 `INVALID` 다.
    if (defects === 0) errors.push(field('defectRecordId', ERROR_CODE.INVALID, '없는 불량 기록입니다.'));
    if (uoms === 0) errors.push(field('uomId', ERROR_CODE.INVALID, '없는 단위입니다.'));
    if (processes === 0) errors.push(field('repairProcessId', ERROR_CODE.INVALID, '없는 공정입니다.'));
    if (errors.length > 0) throw new ContractException(HttpStatus.BAD_REQUEST, errors);
  }
}

/** 계약이 `["integer","null"]` 로 열어 둔 칸 — 널과 부재를 같게 다룬다(⌜받으면 저장⌝ · §1-4). */
function nullableId(value: number | null | undefined): bigint | null {
  return value === undefined || value === null ? null : BigInt(value);
}
