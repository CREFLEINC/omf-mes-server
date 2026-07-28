/**
 * 「POP 작업 시작」 개발·검증용 픽스처.
 *
 * 작업 시작은 배포된 W/O가 있어야 돌아가는데, W/O를 만드는 전개 API(WF02 S1~S4)는
 * 아직 없다. 그 앞단을 대신해 최소 한 벌을 직접 심는다 — 조직·품목·라우팅부터
 * 배포된 W/O·단말·작업자까지.
 *
 * 실행: `npm run fixtures:pop` · e2e(test/pop-work-start.e2e-spec.ts)도 같은 함수를 쓴다.
 * 여러 번 돌려도 같은 결과가 되도록 전부 upsert다.
 */
import { PrismaClient } from '@prisma/client';

export const PLANT_CODE = 'PLANT_1';
export const PROCESS_CODE = 'INJECTION';
export const ITEM_CODE = 'ITEM_HOUSING';
export const TERMINAL_CODE = 'POP_INJ_01';
export const WORKER_NO = 'EMP-1043';
export const WORK_ORDER_NO = 'WO-FIXTURE-0001';

export interface PopWorkStartFixture {
  plantId: bigint;
  processId: bigint;
  workOrderId: bigint;
  shiftId: bigint;
}

export async function seedPopWorkStartFixture(
  prisma: PrismaClient,
): Promise<PopWorkStartFixture> {
  const uom = await prisma.uom.findUniqueOrThrow({ where: { uom_code: 'EA' } });

  const legalEntity = await prisma.legal_entity.upsert({
    where: { legal_entity_code: 'OMF' },
    update: {},
    create: {
      legal_entity_code: 'OMF',
      legal_entity_name: 'OMF Vietnam',
      country_code: 'VNM',
      timezone_code: 'Asia/Ho_Chi_Minh',
    },
  });

  const businessUnit = await prisma.business_unit.upsert({
    where: {
      legal_entity_id_business_unit_code: {
        legal_entity_id: legalEntity.legal_entity_id,
        business_unit_code: 'BU_1',
      },
    },
    update: {},
    create: {
      legal_entity_id: legalEntity.legal_entity_id,
      business_unit_code: 'BU_1',
      business_unit_name: '제1사업부',
    },
  });

  const plant = await prisma.plant.upsert({
    where: {
      legal_entity_id_plant_code: {
        legal_entity_id: legalEntity.legal_entity_id,
        plant_code: PLANT_CODE,
      },
    },
    update: {},
    create: {
      legal_entity_id: legalEntity.legal_entity_id,
      plant_code: PLANT_CODE,
      plant_name: '제1공장',
      timezone_code: 'Asia/Ho_Chi_Minh',
    },
  });

  const shift = await prisma.shift.upsert({
    where: { plant_id_shift_code: { plant_id: plant.plant_id, shift_code: 'DAY' } },
    update: {},
    create: {
      plant_id: plant.plant_id,
      shift_code: 'DAY',
      shift_name: '주간',
      start_time: new Date('1970-01-01T08:00:00Z'),
      end_time: new Date('1970-01-01T20:00:00Z'),
    },
  });

  const process = await prisma.process.upsert({
    where: { process_code: PROCESS_CODE },
    update: {},
    create: {
      process_code: PROCESS_CODE,
      process_name: '사출',
      process_type_code: 'INTERNAL',
    },
  });

  const item = await prisma.item.upsert({
    where: { item_code: ITEM_CODE },
    update: {},
    create: {
      item_code: ITEM_CODE,
      item_name: '하우징',
      item_type_code: 'FG',
      base_uom_id: uom.uom_id,
      lot_control_type_code: 'LOT',
    },
  });

  const routing = await prisma.routing.upsert({
    where: {
      item_id_routing_code_routing_version: {
        item_id: item.item_id,
        routing_code: 'RT_HOUSING',
        routing_version: 1,
      },
    },
    update: {},
    create: {
      item_id: item.item_id,
      routing_code: 'RT_HOUSING',
      routing_version: 1,
      status_code: 'ACTIVE',
      effective_from: new Date('2026-01-01'),
    },
  });

  const operation = await prisma.routing_operation.upsert({
    where: {
      routing_id_operation_seq: { routing_id: routing.routing_id, operation_seq: 10 },
    },
    update: {},
    create: {
      routing_id: routing.routing_id,
      operation_seq: 10,
      process_id: process.process_id,
      operation_name: '사출 성형',
    },
  });

  const bom = await prisma.bom.upsert({
    where: {
      parent_item_id_bom_code_bom_version: {
        parent_item_id: item.item_id,
        bom_code: 'BOM_HOUSING',
        bom_version: 1,
      },
    },
    update: {},
    create: {
      parent_item_id: item.item_id,
      bom_code: 'BOM_HOUSING',
      bom_version: 1,
      status_code: 'ACTIVE',
      is_default: true,
      effective_from: new Date('2026-01-01'),
      base_qty: 1,
      base_uom_id: uom.uom_id,
    },
  });

  const productionOrder = await prisma.production_order.upsert({
    where: { production_order_no: 'PO-FIXTURE-0001' },
    update: {},
    create: {
      production_order_no: 'PO-FIXTURE-0001',
      business_unit_id: businessUnit.business_unit_id,
      plant_id: plant.plant_id,
      item_id: item.item_id,
      order_qty: 1000,
      uom_id: uom.uom_id,
      status_code: 'RELEASED',
    },
  });

  const plan = await prisma.production_plan.upsert({
    where: { plan_no: 'PP-FIXTURE-0001' },
    update: {},
    create: {
      production_order_id: productionOrder.production_order_id,
      plan_no: 'PP-FIXTURE-0001',
      plan_date: new Date('2026-07-28'),
      planned_qty: 1000,
      uom_id: uom.uom_id,
      bom_id: bom.bom_id,
      routing_id: routing.routing_id,
      status_code: 'CONFIRMED',
    },
  });

  // 「배포됨」 = 생산관리자가 확정해 현장에 내린 상태. released_at이 그 시점이다.
  const workOrder = await prisma.work_order.upsert({
    where: { work_order_no: WORK_ORDER_NO },
    update: {},
    create: {
      work_order_no: WORK_ORDER_NO,
      production_plan_id: plan.production_plan_id,
      routing_operation_id: operation.routing_operation_id,
      item_id: item.item_id,
      order_qty: 1000,
      uom_id: uom.uom_id,
      planned_shift_id: shift.shift_id,
      status_code: 'RELEASED',
      released_at: new Date(),
    },
  });

  const terminal = await prisma.terminal.upsert({
    where: { terminal_code: TERMINAL_CODE },
    update: {},
    create: {
      terminal_code: TERMINAL_CODE,
      plant_id: plant.plant_id,
      terminal_type_code: 'POP',
      status_code: 'NORMAL',
    },
  });

  await prisma.terminal_process.upsert({
    where: {
      terminal_id_process_id: {
        terminal_id: terminal.terminal_id,
        process_id: process.process_id,
      },
    },
    update: { can_start_work: true, can_input_result: true },
    create: {
      terminal_id: terminal.terminal_id,
      process_id: process.process_id,
      can_start_work: true,
      can_input_result: true,
    },
  });

  await prisma.worker.upsert({
    where: { worker_no: WORKER_NO },
    update: {},
    create: {
      worker_no: WORKER_NO,
      worker_name: '김작업',
      business_unit_id: businessUnit.business_unit_id,
      plant_id: plant.plant_id,
      status_code: 'ACTIVE',
    },
  });

  return {
    plantId: plant.plant_id,
    processId: process.process_id,
    workOrderId: workOrder.work_order_id,
    shiftId: shift.shift_id,
  };
}

/**
 * 픽스처 W/O를 「막 배포된」 상태로 되돌린다 — 열린 세션을 지우고 상태를 RELEASED로.
 *
 * **픽스처 W/O에 달린 것만 지운다.** work_session 전체를 비우면 같은 DB를 쓰는
 * 다른 작업의 데이터까지 날아간다.
 */
export async function resetPopWorkStartState(prisma: PrismaClient): Promise<void> {
  const sessions = await prisma.work_session.findMany({
    where: { work_order: { work_order_no: WORK_ORDER_NO } },
    select: { work_session_id: true },
  });
  const ids = sessions.map((session) => session.work_session_id);

  if (ids.length > 0) {
    await prisma.$transaction([
      prisma.work_session_event.deleteMany({ where: { work_session_id: { in: ids } } }),
      prisma.work_session_worker.deleteMany({ where: { work_session_id: { in: ids } } }),
      prisma.work_session.deleteMany({ where: { work_session_id: { in: ids } } }),
    ]);
  }

  await prisma.work_order.updateMany({
    where: { work_order_no: WORK_ORDER_NO },
    data: { status_code: 'RELEASED' },
  });
}

if (require.main === module) {
  const prisma = new PrismaClient();
  seedPopWorkStartFixture(prisma)
    .then((fixture) => {
      // eslint-disable-next-line no-console
      console.log(
        [
          'POP 작업 시작 픽스처 준비 완료',
          `  단말     ${TERMINAL_CODE} (${PROCESS_CODE} 시작 허용)`,
          `  사번     ${WORKER_NO}`,
          `  작업지시 ${WORK_ORDER_NO} (id=${fixture.workOrderId}, RELEASED)`,
        ].join('\n'),
      );
    })
    .catch((error) => {
      // eslint-disable-next-line no-console
      console.error(error);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
