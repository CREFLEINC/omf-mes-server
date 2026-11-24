/**
 * 피처 015 엑셀 내보내기 — POST /trace/forward-exports · POST /trace/backward-exports (contracts §5 · FR-014 · R-8).
 *
 * 계보 사슬(quickstart 「준비」, 2026-09-10)에 더해: 여러 길(X → S1·S2 → F), 상한(CAP → 생산 LOT 5,001개),
 * 응답 시간용 생산 LOT 100개(RP), 다른 공장 LOT.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Workbook, Worksheet } from 'exceljs';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PrismaService } from '../src/prisma/prisma.service';
import { TraceExportService } from '../src/trace/tree/trace-export.service';
import { ChainIds, TraceTreeFixture, dropTraceUser, traceLogin } from './support/trace-tree-fixture';

const PREFIX = 'TEXE2E';
const DAY = '2026-09-10';
const USERS = { both: `${PREFIX}-both`, material: `${PREFIX}-material`, product: `${PREFIX}-product` };
const at = TraceTreeFixture.at;
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Row = (string | number | null)[];

describe('피처 015 엑셀 내보내기 (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fx: TraceTreeFixture;
  let chain: ChainIds;
  const cookies = {} as Record<keyof typeof USERS, string[]>;
  const ids: Record<string, bigint> = {};
  const rp: bigint[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, 'api');
    await app.init();
    prisma = app.get(PrismaService);
    fx = new TraceTreeFixture(prisma, PREFIX);
    await fx.cleanup();
    await fx.setup();
    chain = await fx.chain(DAY);
    await extras();
    // 갓 복사한 시험 DB 는 통계가 비어 있다(trace-tree e2e 와 같은 까닭).
    await prisma.$executeRawUnsafe('ANALYZE trace.lot, trace.lot_relation, production.material_consumption, production.production_result_lot_allocation');
    cookies.both = await traceLogin(app, prisma, USERS.both, ['W-02-13', 'W-02-14']);
    cookies.material = await traceLogin(app, prisma, USERS.material, ['W-02-13']);
    cookies.product = await traceLogin(app, prisma, USERS.product, ['W-02-14']);
  }, 300_000);

  afterAll(async () => {
    await fx.cleanup();
    for (const loginId of Object.values(USERS)) await dropTraceUser(prisma, loginId);
    await app.close();
  });

  const post = (path: 'forward-exports' | 'backward-exports', body: Record<string, unknown>, who: keyof typeof USERS = 'both') =>
    request(app.getHttpServer()).post(`/api/trace/${path}`).set('Cookie', cookies[who])
      .send({ plantId: Number(fx.ids.plant), ...body })
      .buffer(true)
      .parse((response, done) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done(null, Buffer.concat(chunks)));
      });
  const sheetRows = (sheet: Worksheet | undefined): Row[] => {
    const rows: Row[] = [];
    // 끝의 빈 칸은 exceljs 가 싣지 않는다 — 머리 열 수만큼 채운다.
    const width = sheet?.columnCount ?? 0;
    sheet?.eachRow((row) => {
      const values = (row.values as (string | number | null)[]).slice(1);
      rows.push(Array.from({ length: width }, (_, i) => values[i] ?? null));
    });
    return rows;
  };
  const open = async (buffer: Buffer) => {
    const book = new Workbook();
    await book.xlsx.load(buffer as unknown as ArrayBuffer);
    return { end: sheetRows(book.getWorksheet('최종 LOT')), lineage: sheetRows(book.getWorksheet('LOT 계보')) };
  };
  const col = (header: Row, name: string) => {
    const index = header.indexOf(name);
    if (index < 0) throw new Error(`열이 없다: ${name} — ${header.join(',')}`);
    return index;
  };

  it('US4-1 Q20 forward-exports — 「최종 LOT」(첫 열 기준 LOT, 본문 순서, 출하마다 한 줄)·「LOT 계보」(기준 LOT 마다 전체, 근거 열)', async () => {
    const response = await post('forward-exports', { lotIds: [Number(chain.a), Number(chain.b), Number(ids.x)] }).expect(200);

    expect(response.headers['content-type']).toContain(XLSX);
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="material-trace-\d{8}-\d{4}\.xlsx"/);
    const { end, lineage } = await open(response.body as Buffer);
    const [head, ...rows] = end;
    expect(head[0]).toBe('기준 LOT');
    const base = col(head, '기준 LOT');
    const lot = col(head, '제품 LOT');
    expect(rows.map((row) => [row[base], row[lot]])).toEqual([
      [fx.no('A'), fx.no('P2')], [fx.no('A'), fx.no('P3')], [fx.no('A'), fx.no('P4')], [fx.no('A'), fx.no('P4-S1')],
      [fx.no('B'), fx.no('P3')], [fx.no('X'), fx.no('F')],
    ]);
    const p3 = rows[1];
    expect([p3[col(head, '현황')], p3[col(head, '고객')], p3[col(head, '출하번호')], p3[col(head, '출하 수량')]]).toEqual(['출하', `추적CUS-X`, fx.no('SH-1'), 20]);

    const [lineHead, ...lines] = lineage;
    expect(lineHead.slice(0, 4)).toEqual(['기준 LOT', '깊이', '단계', '번호']);
    const no = col(lineHead, '번호');
    const basis = col(lineHead, '연결 근거');
    const note = col(lineHead, '비고');
    const ofA = lines.filter((line) => line[0] === fx.no('A'));
    // 접힘과 상관없이 전체 — A 의 계보 항목 14개(A·W/O 3·생산 LOT 4·분할 2·출하 2·재고 2)가 모두 들어간다.
    expect(ofA).toHaveLength(14);
    expect(ofA[0]).toEqual(expect.arrayContaining([fx.no('A'), 0, '자재 LOT']));
    expect(ofA.map((line) => line[no])).toEqual(expect.arrayContaining([fx.no('WO-1'), fx.no('P1'), fx.no('WO-2'), fx.no('P3'), fx.no('SH-1'), fx.no('A-S1'), fx.no('P4-S1'), fx.no('SH-2')]));
    expect(ofA.find((line) => line[no] === fx.no('P1'))?.[basis]).toBe('추정(계보)');
    expect(ofA.find((line) => line[no] === fx.no('A-S1'))?.[basis]).toBe('기록');
    // 여러 길 — 두 번째로 닿은 W/O M3 는 「중복 — 위와 같음」이고 다시 펼치지 않는다.
    const ofX = lines.filter((line) => line[0] === fx.no('X'));
    expect(ofX.filter((line) => line[no] === fx.no('WO-M3')).map((line) => line[note])).toEqual([null, '중복 — 위와 같음']);
    expect(ofX.filter((line) => line[no] === fx.no('F'))).toHaveLength(1);
    expect(lines.filter((line) => line[0] === fx.no('B'))[0]).toEqual(expect.arrayContaining([fx.no('B'), 0]));
  });

  it('US4-1 Q20 backward-exports — serialNos 를 준 LOT 은 계보 줄 맨 위가 시리얼, 최종 LOT 은 원자재 × W/O', async () => {
    const response = await post('backward-exports', { lotIds: [Number(chain.p3), Number(chain.p4S1)], serialNos: { [String(chain.p3)]: fx.no('SN-1') } }).expect(200);

    expect(response.headers['content-disposition']).toMatch(/filename="product-trace-\d{8}-\d{4}\.xlsx"/);
    const { end, lineage } = await open(response.body as Buffer);
    const [head, ...rows] = end;
    expect(rows.map((row) => [row[col(head, '기준 LOT')], row[col(head, '자재 LOT')], row[col(head, 'W/O')]])).toEqual([
      [fx.no('P3'), fx.no('A'), fx.no('WO-1')], [fx.no('P3'), fx.no('B'), fx.no('WO-2')], [fx.no('P4-S1'), fx.no('A-S1'), fx.no('WO-3')],
    ]);
    expect(rows[0][col(head, '공급사 LOT')]).toBe(fx.no('SUP-A'));
    const [lineHead, ...lines] = lineage;
    const first = lines.find((line) => line[0] === fx.no('P3'));
    expect([first?.[col(lineHead, '깊이')], first?.[col(lineHead, '단계')], first?.[col(lineHead, '번호')]]).toEqual([0, '시리얼', fx.no('SN-1')]);
  });

  it('US4-1 D9 엑셀 말이 화면과 같다 — LOT 상태 이름·단계(반제품·분할·분리)·창고 위치 이름·「원래 LOT」·「현황」·천 단위 표시', async () => {
    const response = await post('forward-exports', { lotIds: [Number(chain.a)] }).expect(200);
    const book = new Workbook();
    await book.xlsx.load(response.body as unknown as ArrayBuffer);
    const { end, lineage } = await open(response.body as Buffer);
    const [head, ...rows] = end;
    expect(head).toEqual(expect.arrayContaining(['현황', '창고', '위치', 'LOT 상태']));
    expect(head).not.toContain('행방');
    const p2 = rows.find((row) => row[col(head, '제품 LOT')] === fx.no('P2')) as Row;
    expect([p2[col(head, '현황')], p2[col(head, '창고')], p2[col(head, '위치')], p2[col(head, 'LOT 상태')]])
      .toEqual(['재고', `추적창고${PREFIX}-P (${PREFIX}-P-WH)`, `추적위치${PREFIX}-P (${PREFIX}-P-LOC)`, '정상']);
    const [lineHead, ...lines] = lineage;
    expect(lineHead).toContain('상위 항목');
    expect(lineHead).not.toContain('원래 LOT');
    expect(lineHead).not.toContain('부모 번호');
    const stage = (no: string) => lines.find((line) => line[col(lineHead, '번호')] === no)?.[col(lineHead, '단계')];
    expect([stage(fx.no('A')), stage(fx.no('P1')), stage(fx.no('P2')), stage(fx.no('A-S1')), stage(fx.no('P4-S1'))])
      .toEqual(['자재 LOT', '반제품 LOT', '생산 LOT', '분할 LOT', '분리 LOT']);
    const p1 = lines.find((line) => line[col(lineHead, '번호')] === fx.no('P1')) as Row;
    expect([p1[col(lineHead, '상위 항목')], p1[col(lineHead, 'LOT 상태')]]).toEqual([fx.no('WO-1'), '정상']);
    expect(lines.find((line) => line[col(lineHead, '단계')] === '재고')?.[col(lineHead, '번호')])
      .toBe(`추적창고${PREFIX}-P (${PREFIX}-P-WH) / 추적위치${PREFIX}-P (${PREFIX}-P-LOC)`);
    // 숫자 칸은 천 단위 표시 형식이다.
    const sheet = book.getWorksheet('최종 LOT');
    expect(sheet?.getRow(2).getCell(col(head, '생산 수량') + 1).numFmt).toBe('#,##0');
  });

  it('US4-1 N3 「LOT 계보」의 바로 위 항목 칸은 「상위 항목」 — 분할·분리 모 LOT 을 뜻하는 「원래 LOT」과 다르다', async () => {
    const response = await post('forward-exports', { lotIds: [Number(chain.a)] }).expect(200);
    const { end, lineage } = await open(response.body as Buffer);
    const [lineHead, ...lines] = lineage;
    const parentOf = (no: string) => lines.find((line) => line[col(lineHead, '번호')] === fx.no(no))?.[col(lineHead, '상위 항목')];
    expect([parentOf('WO-1'), parentOf('P1'), parentOf('A-S1'), parentOf('P4-S1')]).toEqual([fx.no('A'), fx.no('WO-1'), fx.no('A'), fx.no('P4')]);
    expect(lines[0][col(lineHead, '상위 항목')]).toBeNull();
    // 「최종 LOT」 시트에는 이런 칸이 없다.
    expect(end[0]).not.toContain('원래 LOT');
    expect(end[0]).not.toContain('상위 항목');
  });

  it('US4-1 D9 역방향 계보 단계 — 분리 자식이 가리키면 「분리된 원래 LOT」, 분할 자식이 가리키면 「분할된 원래 LOT」', async () => {
    const response = await post('backward-exports', { lotIds: [Number(chain.p4S1)] }).expect(200);
    const [lineHead, ...lines] = (await open(response.body as Buffer)).lineage;
    expect(lines.map((line) => [line[col(lineHead, '번호')], line[col(lineHead, '단계')]])).toEqual(expect.arrayContaining([
      [fx.no('P4-S1'), '분리 LOT'], [fx.no('P4'), '분리된 원래 LOT'], [fx.no('A-S1'), '분할 LOT'], [fx.no('A'), '분할된 원래 LOT'],
    ]));
  });

  it('US4-1 D9 language vi 면 시트·머리·단계가 베트남어, LOT 상태는 공통코드 vi 이름', async () => {
    await prisma.$executeRawUnsafe(`UPDATE mdm.code_value cv SET name_vi = 'Bình thường' FROM mdm.code_group cg
      WHERE cg.code_group_id = cv.code_group_id AND cg.group_code = 'LOT_STATUS' AND cv.code = 'NORMAL'`);
    try {
      const response = await post('forward-exports', { lotIds: [Number(chain.p1)], language: 'vi' }).expect(200);
      const book = new Workbook();
      await book.xlsx.load(response.body as unknown as ArrayBuffer);
      const [head, ...lines] = sheetRows(book.getWorksheet('Phả hệ LOT'));
      expect(head).toContain('Mục cấp trên');
      expect(lines[0]).toEqual(expect.arrayContaining([fx.no('P1'), 'LOT bán thành phẩm', 'Bình thường']));
      expect(book.getWorksheet('LOT cuối')).toBeDefined();
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE mdm.code_value cv SET name_vi = NULL FROM mdm.code_group cg
        WHERE cg.code_group_id = cv.code_group_id AND cg.group_code = 'LOT_STATUS' AND cv.code = 'NORMAL'`);
    }
  });

  it('US4-1 D9 IQC 칸은 판정 코드가 아니라 공통코드 INSPECTION_RESULT_OVERALL_JUDGMENT 이름(언어별, 비면 기본 이름)', async () => {
    const ko = await post('backward-exports', { lotIds: [Number(chain.p3)] }).expect(200);
    const [head, ...rows] = (await open(ko.body as Buffer)).end;
    const iqcOf = (list: Row[], no: string) => list.find((row) => row[col(head, '자재 LOT')] === fx.no(no))?.[col(head, 'IQC')];
    expect(iqcOf(rows, 'A')).toBe('합격');
    expect(iqcOf(rows, 'B')).toBeNull();
    await prisma.$executeRawUnsafe(`UPDATE mdm.code_value cv SET name_vi = 'Đạt' FROM mdm.code_group cg
      WHERE cg.code_group_id = cv.code_group_id AND cg.group_code = 'INSPECTION_RESULT_OVERALL_JUDGMENT' AND cv.code = 'ACCEPTED'`);
    try {
      const vi = await post('backward-exports', { lotIds: [Number(chain.p3)], language: 'vi' }).expect(200);
      const book = new Workbook();
      await book.xlsx.load(vi.body as unknown as ArrayBuffer);
      const [viHead, ...viRows] = sheetRows(book.getWorksheet('LOT cuối'));
      expect(viRows.find((row) => row[viHead.indexOf('LOT vật tư')] === fx.no('A'))?.[viHead.indexOf('IQC')]).toBe('Đạt');
    } finally {
      await prisma.$executeRawUnsafe(`UPDATE mdm.code_value cv SET name_vi = NULL FROM mdm.code_group cg
        WHERE cg.code_group_id = cv.code_group_id AND cg.group_code = 'INSPECTION_RESULT_OVERALL_JUDGMENT' AND cv.code = 'ACCEPTED'`);
    }
  });

  it('US4-1 한 기준 LOT 이 상한에 걸리면 그 LOT 줄 비고에 「일부」 — 다 따라간 기준 LOT 은 그대로', async () => {
    // 기준 LOT 들을 한 번에 따라가고 상한(겹치지 않는 LOT 5,000)도 함께 센다. 멈춘 단계에서 펼치지 못한 LOT 이 닿는 기준만 「일부」다.
    const response = await post('forward-exports', { lotIds: [Number(ids.cap), Number(chain.p3)] }).expect(200);
    const { end } = await open(response.body as Buffer);
    const [head, ...rows] = end;
    const note = col(head, '비고');
    const cap = rows.filter((row) => row[0] === fx.no('CAP'));
    expect(cap).toHaveLength(5001);
    expect(cap.every((row) => row[note] === '일부')).toBe(true);
    expect(rows.filter((row) => row[0] === fx.no('P3')).map((row) => row[note])).toEqual([null]);
  });

  it('US4-3 lotIds 0개·201개는 400, 「LOT 계보」 상한을 넘으면 422 TRACE_EXPORT_TOO_LARGE', async () => {
    await post('forward-exports', { lotIds: [] }).expect(400);
    await post('forward-exports', { lotIds: Array.from({ length: 201 }, (_, i) => i + 1) }).expect(400);
    const service = app.get(TraceExportService);
    service.lineageRowCap = 10;
    try {
      const response = await request(app.getHttpServer()).post('/api/trace/forward-exports').set('Cookie', cookies.both)
        .send({ plantId: Number(fx.ids.plant), lotIds: [Number(chain.a)] }).expect(422);
      expect(response.body.errors[0]).toMatchObject({ code: 'TRACE_EXPORT_TOO_LARGE' });
    } finally {
      service.lineageRowCap = 100_000;
    }
  });

  it('US4-1 다른 공장 LOT 은 404, 권한 — forward 는 W-02-13, backward 는 W-02-14', async () => {
    await post('forward-exports', { lotIds: [Number(ids.other)] }).expect(404);
    await post('forward-exports', { lotIds: [Number(chain.a)] }, 'product').expect(403);
    await post('backward-exports', { lotIds: [Number(chain.p3)] }, 'material').expect(403);
  });

  it('Q23 100 LOT 내보내기 응답 시간을 기록한다 — 목표 20초', async () => {
    const started = Date.now();
    const response = await post('backward-exports', { lotIds: rp.map(Number) }).expect(200);
    const elapsed = Date.now() - started;
    const { lineage } = await open(response.body as Buffer);
    expect(new Set(lineage.slice(1).map((line) => line[0])).size).toBe(100);
    // eslint-disable-next-line no-console -- 응답 시간 기록(verification SC-002 · Q23)
    console.log(`[Q23] backward-exports 100 LOT ${elapsed}ms`);
    expect(elapsed).toBeLessThan(20_000);
  });

  async function extras(): Promise<void> {
    const t = (hour: number) => at(DAY, hour);
    // IL-1 IQC 합격(ACCEPTED — 실제 판정 코드). IL-B 는 IQC 없음.
    await fx.iqc('IL1', chain.il1, 'ACCEPTED', t(7));
    ids.x = await fx.lot('X', fx.ids.mat);
    const m1 = await fx.workOrder('M1', fx.ids.semi);
    const m2 = await fx.workOrder('M2', fx.ids.semi);
    const m3 = await fx.workOrder('M3', fx.ids.fg);
    const s1 = await fx.productionLot('S1', fx.ids.semi, m1);
    const s2 = await fx.productionLot('S2', fx.ids.semi, m2);
    const f = await fx.productionLot('F', fx.ids.fg, m3);
    await fx.consume(m1, ids.x, 10, t(8));
    await fx.consume(m2, ids.x, 10, t(8));
    await fx.produce(m1, s1, 10, t(9), [ids.x]);
    await fx.produce(m2, s2, 10, t(9), [ids.x]);
    await fx.consume(m3, s1, 10, t(10));
    await fx.consume(m3, s2, 10, t(10));
    await fx.produce(m3, f, 20, t(11), [s1, s2]);
    ids.cap = await fx.lot('CAP', fx.ids.mat);
    const capWo = await fx.workOrder('CAPWO', fx.ids.fg);
    await fx.consume(capWo, ids.cap, 1, t(8));
    await bulk(capWo, 'CAPP', 5001, t(9));
    const rpWo = await fx.workOrder('RPWO', fx.ids.fg);
    const rpSource = await fx.lot('RPSRC', fx.ids.mat);
    await fx.consume(rpWo, rpSource, 100, t(8));
    rp.push(...await bulk(rpWo, 'RP', 100, t(9), rpSource));
    ids.other = await fx.lot('OTHER', fx.ids.mat, { plant: fx.ids.otherPlant });
  }

  async function bulk(workOrderId: bigint, prefix: string, count: number, when: Date, source?: bigint): Promise<bigint[]> {
    await prisma.lot.createMany({ data: Array.from({ length: count }, (_, i) => ({
      lot_no: fx.no(`${prefix}-${String(i).padStart(4, '0')}`), item_id: fx.ids.fg, lot_type_code: 'PRODUCTION', plant_id: fx.ids.plant, initial_qty: 1,
      uom_id: fx.ids.uom, source_type_code: 'WORK_ORDER', source_id: workOrderId, status_code: 'NORMAL',
    })) });
    const lots = await prisma.lot.findMany({ where: { plant_id: fx.ids.plant, lot_no: { startsWith: fx.no(`${prefix}-`) } }, select: { lot_id: true }, orderBy: { lot_id: 'asc' } });
    const result = await prisma.production_result.create({ data: {
      production_result_no: fx.no(`PR-${prefix}`), work_order_id: workOrderId, result_sequence: 1, good_qty: count, uom_id: fx.ids.uom,
      result_source_code: 'POP', occurred_at: when, worker_id: fx.ids.worker, status_code: 'CONFIRMED', idempotency_key: fx.no(`PR-${prefix}-key`),
    } });
    await prisma.production_result_lot_allocation.createMany({ data: lots.map((lot) => ({
      production_result_id: result.production_result_id, lot_id: lot.lot_id, allocated_qty: 1, uom_id: fx.ids.uom,
    })) });
    if (source !== undefined) {
      await prisma.lot_relation.createMany({ data: lots.map((lot) => ({
        source_lot_id: source, target_lot_id: lot.lot_id, relation_type_code: 'CONSUMED', relation_qty: 1, uom_id: fx.ids.uom,
        source_event_type_code: 'PRODUCTION_RESULT', source_event_id: result.production_result_id, allocation_method_code: 'INPUT_TIME_WINDOW',
        trace_accuracy_code: 'ESTIMATED', occurred_at: when,
      })) });
    }
    return lots.map((lot) => lot.lot_id);
  }
});
