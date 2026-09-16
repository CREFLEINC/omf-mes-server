import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Prisma } from "@prisma/client";
import { Test } from "@nestjs/testing";
import Ajv2020, { ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";

import { AppModule } from "../src/app.module";
import { configureApp } from "../src/app.setup";
import { SESSION_COOKIE } from "../src/auth/session-cookie";
import { TOKEN_TYPE } from "../src/auth/session-resolver.service";
import { PrismaService } from "../src/prisma/prisma.service";

const TOKEN = randomUUID().replace(/-/g, "").slice(0, 8);
const PREFIX = `E2E_I27W_${TOKEN}`;
const PATH = "/api/app/document-issues";
const REASON = `${PREFIX}_REPRINT`;
const LOCATION_COUNT = 1_003;

function responseValidator(status: 201 | 422): ValidateFunction {
  const contract = JSON.parse(
    readFileSync(join(__dirname, "../contracts/app-공통.json"), "utf8"),
  ) as object;
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const format of [
    "int64",
    "int32",
    "double",
    "float",
    "binary",
    "password",
  ]) {
    ajv.addFormat(format, true);
  }
  ajv.addSchema(contract, "https://omf-mes.invalid/contract");
  return ajv.compile({
    $ref:
      "https://omf-mes.invalid/contract#/paths/" +
      "~1app~1document-issues/post/responses/" +
      `${status}/content/application~1json/schema`,
  });
}

describe("발행·재발행 (I-27 C3d e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let userId: bigint;
  let plantId: bigint;
  let warehouseId: bigint;
  let itemId: bigint;
  let uomId: bigint;
  let workerId: bigint;
  let cookie: string;
  let locationIds: bigint[] = [];
  const keys: string[] = [];
  const validateCreated = responseValidator(201);
  const validateUnprocessable = responseValidator(422);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app, "api");
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();
    await makeFixture(app.get(JwtService));
  });

  afterAll(async () => {
    try {
      await cleanup();
      expect(
        await Promise.all([
          prisma.document_issue_log.count({
            where: { remarks: { startsWith: PREFIX } },
          }),
          prisma.idempotency_record.count({
            where: { idempotency_key: { in: keys } },
          }),
          prisma.location.count({
            where: { location_code: { startsWith: PREFIX } },
          }),
          prisma.app_user.count({
            where: { login_id: { startsWith: PREFIX } },
          }),
          prisma.inspection_result.count({
            where: { inspection_result_no: { startsWith: PREFIX } },
          }),
          prisma.inspection_request.count({
            where: { inspection_request_no: { startsWith: PREFIX } },
          }),
          prisma.goods_issue.count({
            where: { goods_issue_no: { startsWith: PREFIX } },
          }),
          prisma.goods_issue_line.count({
            where: {
              goods_issue: { goods_issue_no: { startsWith: PREFIX } },
            },
          }),
          prisma.lot.count({ where: { lot_no: { startsWith: PREFIX } } }),
          prisma.worker.count({ where: { worker_no: { startsWith: PREFIX } } }),
          prisma.item.count({ where: { item_code: { startsWith: PREFIX } } }),
          prisma.uom.count({ where: { uom_code: { startsWith: PREFIX } } }),
        ]),
      ).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    } finally {
      await app?.close();
    }
  });

  it("계정 요청은 사번·단말 없이 PENDING 최초 발행을 만들고 계약 응답을 반환한다", async () => {
    const response = await issue([locationIds[0]], {
      printerName: `${PREFIX}_PRINTER`,
      remarks: `${PREFIX}_FIRST`,
    }).expect(201);

    expect(validateCreated(response.body)).toBe(true);
    expect(validateCreated.errors ?? []).toEqual([]);
    expect(response.body).toMatchObject({
      issuedCount: 1,
      items: [
        {
          documentTypeCode: "LOCATION_LABEL",
          target: {
            targetTypeCode: "LOCATION",
            targetId: Number(locationIds[0]),
            displayName: `${PREFIX} 위치 0`,
            screenId: "W-06-07",
          },
          lotId: null,
          lotNo: null,
          issueSeq: 1,
          reissueReasonCode: null,
          reissueReasonName: null,
          issuedBy: Number(userId),
          issuedByName: "I-27 발행 E2E 계정",
          terminalId: null,
          printerName: `${PREFIX}_PRINTER`,
          printOutcome: "PENDING",
          remarks: `${PREFIX}_FIRST`,
        },
      ],
    });
    expect(
      await prisma.document_issue_log.findFirstOrThrow({
        where: { remarks: `${PREFIX}_FIRST` },
      }),
    ).toMatchObject({
      issued_by: userId,
      issued_worker_id: null,
      terminal_id: null,
      print_outcome_code: "PENDING",
      print_failure_reason: null,
      print_reported_at: null,
    });
  });

  it("동일 키·동일 요청은 저장된 201을 재생하고 로그를 늘리지 않는다", async () => {
    const key = newKey();
    const options = { remarks: `${PREFIX}_REPLAY`, key };
    const first = await issue([locationIds[1]], options).expect(201);
    const replay = await issue([locationIds[1]], options).expect(201);

    expect(replay.body).toEqual(first.body);
    expect(
      await prisma.document_issue_log.count({
        where: { remarks: `${PREFIX}_REPLAY` },
      }),
    ).toBe(1);
  });

  it("재발행은 활성 사유를 강제하고 2회차에만 원문 코드를 남긴다", async () => {
    const target = locationIds[2];
    await issue([target], { remarks: `${PREFIX}_REISSUE_BASE` }).expect(201);
    const before = await countIssues(target);
    const missing = await issue([target], {
      remarks: `${PREFIX}_MISSING_REASON`,
    }).expect(422);
    expect(validateUnprocessable(missing.body)).toBe(true);
    expect(missing.body.errors).toEqual([
      expect.objectContaining({
        field: "reissueReasonCode",
        code: "REQUIRED",
      }),
    ]);
    expect(await countIssues(target)).toBe(before);

    const response = await issue([target], {
      reissueReasonCode: REASON,
      remarks: `${PREFIX}_REISSUE`,
    }).expect(201);
    expect(response.body.items[0]).toMatchObject({
      issueSeq: 2,
      reissueReasonCode: REASON,
      reissueReasonName: "E2E 재발행",
    });
    const rows = await prisma.document_issue_log.findMany({
      where: {
        document_type_code: "LOCATION_LABEL",
        target_type_code: "LOCATION",
        target_id: target,
      },
      orderBy: { issue_seq: "asc" },
    });
    expect(rows.map((row) => [row.issue_seq, row.reissue_reason_code])).toEqual(
      [
        [1, null],
        [2, REASON],
      ],
    );
  });

  it("검사 확정이 먼저 잠그면 CoA 발행은 확정 결과와 LOT을 다시 읽고 성공한다", async () => {
    const fixture = await newConfirmableCoa("CONFIRM_FIRST");
    const blocker = await blockInspectionResult(fixture.resultId);

    try {
      const confirm = confirmInspection(fixture.resultId).then(
        (response) => response,
      );
      await waitForBlockedQuery("%inspected_qty%FOR UPDATE%");
      const issue = issueCertificate(fixture.resultId, "CONFIRM_FIRST").then(
        (response) => response,
      );
      await waitForBlockedQuery("%confirmed_at%FOR SHARE%");
      blocker.release();

      const [confirmed, issued] = await Promise.all([confirm, issue]);
      expect(confirmed.status).toBe(200);
      expect(issued.status).toBe(201);
      expect(issued.body.items[0]).toMatchObject({
        lotId: Number(fixture.lotId),
        printOutcome: "PENDING",
      });
      expect(await certificateCount(fixture.resultId)).toBe(1);
    } finally {
      blocker.release();
      await blocker.done;
    }
  });

  it("CoA 발행이 먼저 잠그면 DRAFT를 422로 끝낸 뒤 검사 확정이 진행된다", async () => {
    const fixture = await newConfirmableCoa("ISSUE_FIRST");
    const blocker = await blockInspectionResult(fixture.resultId);

    try {
      const issue = issueCertificate(fixture.resultId, "ISSUE_FIRST").then(
        (response) => response,
      );
      await waitForBlockedQuery("%confirmed_at%FOR SHARE%");
      const confirm = confirmInspection(fixture.resultId).then(
        (response) => response,
      );
      await waitForBlockedQuery("%inspected_qty%FOR UPDATE%");
      blocker.release();

      const [rejected, confirmed] = await Promise.all([issue, confirm]);
      expect(rejected.status).toBe(422);
      expect(rejected.body.errors[0]).toMatchObject({
        field: "targets[0].targetId",
        code: "STATE_LOCKED",
      });
      expect(confirmed.status).toBe(200);
      expect(await certificateCount(fixture.resultId)).toBe(0);
      await expect(
        prisma.inspection_result.findUniqueOrThrow({
          where: { inspection_result_id: BigInt(fixture.resultId) },
          select: { status_code: true, confirmed_at: true },
        }),
      ).resolves.toMatchObject({
        status_code: "CONFIRMED",
        confirmed_at: expect.any(Date),
      });
    } finally {
      blocker.release();
      await blocker.done;
    }
  });

  /**
   * ⭐ 이 스위트의 출고 QR 판정은 여태 **거부 쪽만** 봤다(REGISTERED 픽스처 → 422 STATE_LOCKED).
   * 전기된 전표에서 «되는» 것을 아무도 잠그지 않아, 자격 규칙이 반대로 뒤집혀도 초록이었다.
   * P-01-02(출고 QR 발행)가 서는 자리가 바로 이 성공 경로다.
   */
  it("⭐ 전기된 출고의 라인은 출고 QR 발행이 된다(거부 쪽만 보던 그물을 닫는다)", async () => {
    const fixture = await newPostedGoodsIssue("POSTED_OK");

    const response = await issueGoodsIssueLine(fixture, "POSTED_OK");

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      issuedCount: 1,
      items: [
        {
          documentTypeCode: "GOODS_ISSUE_QR",
          issueSeq: 1,
          printOutcome: "PENDING",
          target: {
            targetTypeCode: "GOODS_ISSUE_LINE",
            targetId: Number(fixture.goodsIssueLineId),
            screenId: "P-01-02",
          },
        },
      ],
    });
    expect(await goodsIssueDocumentCount(fixture.goodsIssueLineId)).toBe(1);
  });

  it("출고 라인 writer가 먼저 잠그면 변경 경로를 다시 읽고 발행 전건을 롤백한다", async () => {
    const fixture = await newRegisteredGoodsIssue("WRITER_FIRST");
    const blocker = await blockGoodsIssue(fixture.goodsIssueId);

    try {
      const writer = replaceGoodsIssueLine(fixture).then(
        (response) => response,
      );
      await waitForBlockedQuery("%status_code, version_no%FOR UPDATE%");
      const issue = issueGoodsIssueLine(fixture, "WRITER_FIRST").then(
        (response) => response,
      );
      await waitForBlockedQuery(
        "%goods_issue_id,status_code%FOR NO KEY UPDATE%",
      );
      blocker.release();

      const [changed, rejected] = await Promise.all([writer, issue]);
      expect(changed.status).toBe(200);
      expect(rejected.status).toBe(422);
      expect(rejected.body.errors[0]).toMatchObject({
        field: "targets[0].targetId",
        code: "STATE_LOCKED",
      });
      await expect(
        prisma.goods_issue_line.findUniqueOrThrow({
          where: { goods_issue_line_id: fixture.goodsIssueLineId },
          select: { lot_id: true },
        }),
      ).resolves.toEqual({ lot_id: fixture.replacementLotId });
      expect(await goodsIssueDocumentCount(fixture.goodsIssueLineId)).toBe(0);
    } finally {
      blocker.release();
      await blocker.done;
    }
  });

  it("발행이 먼저 잠그면 판정을 끝낼 때까지 출고 라인 writer를 직렬화한다", async () => {
    const fixture = await newRegisteredGoodsIssue("ISSUE_FIRST");
    const blocker = await blockGoodsIssue(fixture.goodsIssueId);

    try {
      const issue = issueGoodsIssueLine(fixture, "ISSUE_FIRST").then(
        (response) => response,
      );
      await waitForBlockedQuery(
        "%goods_issue_id,status_code%FOR NO KEY UPDATE%",
      );
      const writer = replaceGoodsIssueLine(fixture).then(
        (response) => response,
      );
      await waitForBlockedQuery("%status_code, version_no%FOR UPDATE%");
      blocker.release();

      const [rejected, changed] = await Promise.all([issue, writer]);
      expect(rejected.status).toBe(422);
      expect(rejected.body.errors[0]).toMatchObject({
        field: "targets[0].targetId",
        code: "STATE_LOCKED",
      });
      expect(changed.status).toBe(200);
      await expect(
        prisma.goods_issue_line.findUniqueOrThrow({
          where: { goods_issue_line_id: fixture.goodsIssueLineId },
          select: { lot_id: true },
        }),
      ).resolves.toEqual({ lot_id: fixture.replacementLotId });
      expect(await goodsIssueDocumentCount(fixture.goodsIssueLineId)).toBe(0);
    } finally {
      blocker.release();
      await blocker.done;
    }
  });

  it("1,000건 배치 중간에 미존재 대상이 있으면 전건 롤백한다", async () => {
    const missing = 8_027_399_999_999;
    const targets = locationIds.slice(3, 1_002);
    targets.splice(500, 0, BigInt(missing));
    const key = newKey();
    const response = await issue(targets, {
      remarks: `${PREFIX}_ROLLBACK`,
      key,
    }).expect(422);

    expect(response.body.errors).toEqual([
      expect.objectContaining({
        field: "targets[500].targetId",
        code: "INVALID",
      }),
    ]);
    expect(
      await prisma.document_issue_log.count({
        where: { remarks: `${PREFIX}_ROLLBACK` },
      }),
    ).toBe(0);
    expect(
      await prisma.idempotency_record.findUnique({
        where: { idempotency_key: key },
      }),
    ).toBeNull();
  });

  it("계약 최대치 1,000건을 기본 트랜잭션 제한 안에서 원자 발행·재생한다", async () => {
    const targets = locationIds.slice(3, 1_003);
    const key = newKey();
    const options = { remarks: `${PREFIX}_MAX`, key };
    const startedAt = Date.now();
    const first = await issue(targets, options).expect(201);
    const elapsed = Date.now() - startedAt;

    expect(first.body.issuedCount).toBe(1_000);
    expect(first.body.items).toHaveLength(1_000);
    expect(
      first.body.items.map(
        (item: { target: { targetId: number } }) => item.target.targetId,
      ),
    ).toEqual(targets.map(Number));
    expect(elapsed).toBeLessThan(5_000);

    const replay = await issue(targets, options).expect(201);
    expect(replay.body).toEqual(first.body);
    expect(
      await prisma.document_issue_log.count({
        where: { remarks: `${PREFIX}_MAX` },
      }),
    ).toBe(1_000);
  });

  /**
   * ⭐ P-18 — 생산 LOT 라벨 자격을 «마감 전»으로 열었다. `P-02-04` 는 라벨을 찍어 그 라벨을
   * 스캔하는 것이 마감 입력이라, 완료를 요구하면 라벨과 마감이 서로를 기다린다.
   * 축은 「실적이 반영됐나」 = 생명주기 `ACTIVE`(또는 이미 마감된 LOT)다.
   */
  describe("생산 LOT 라벨 자격 (P-18)", () => {
    it.each([
      ["실적만 반영된 검사대기 LOT", "INSPECTION_PENDING", "ACTIVE", false],
      ["실적이 반영된 정상 LOT", "NORMAL", "ACTIVE", false],
      ["완료된 정상 LOT(재발행 경로)", "NORMAL", null, true],
    ] as const)(
      "%s은 201 로 발행된다",
      async (name, statusCode, lifecycle, completed) => {
        const lotId = await newProductionLot(name, statusCode, lifecycle, completed);

        const response = await issueProductionLot(lotId).expect(201);

        expect(response.body.issuedCount).toBe(1);
        expect(
          await prisma.document_issue_log.count({
            where: { document_type_code: "PRODUCTION_LOT_LABEL", lot_id: lotId },
          }),
        ).toBe(1);
      },
    );

    it.each([
      ["실적이 한 번도 반영되지 않은 슬롯", "INSPECTION_PENDING", "WAITING", false],
      ["생명주기가 비어 있는 LOT", "NORMAL", null, false],
      ["불량 LOT", "DEFECTIVE", "ACTIVE", true],
      ["폐기 LOT", "SCRAPPED", "ACTIVE", true],
    ] as const)(
      "%s은 422 STATE_LOCKED 로 막힌다",
      async (name, statusCode, lifecycle, completed) => {
        const lotId = await newProductionLot(name, statusCode, lifecycle, completed);

        const rejected = await issueProductionLot(lotId).expect(422);

        expect(rejected.body.errors[0]).toMatchObject({ code: "STATE_LOCKED" });
        expect(
          await prisma.document_issue_log.count({
            where: { document_type_code: "PRODUCTION_LOT_LABEL", lot_id: lotId },
          }),
        ).toBe(0);
      },
    );
  });

  /**
   * ⭐ D5 — POP 이 실적 뒤 라벨을 찍으려면 이 렌디션을 받아야 한다. 전에는 단말 읽기 범위에
   * 생산 LOT 라벨이 없어 401 이었고, 열고 나서도 그릴 판이 없어 422 였다.
   */
  describe("생산 LOT 라벨 렌디션 (D5)", () => {
    it.each([
      ["png", /image\/png/],
      ["tspl", /application\/vnd\.tspl/],
    ] as const)("POP 단말이 자기 공장 LOT 라벨을 %s 로 받는다", async (format, contentType) => {
      const lotId = await newProductionLot(`RENDITION_${format}`, "NORMAL", "ACTIVE", false);
      const issued = await issueProductionLot(lotId).expect(201);
      const logId = issued.body.items[0].documentIssueLogId;

      const response = await request(app.getHttpServer())
        .get(`/api/app/document-issues/${String(logId)}/rendition?format=${format}`)
        .set("Authorization", `Bearer ${await popToken(plantId)}`)
        .buffer(true)
        .parse((stream, callback) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => callback(null, Buffer.concat(chunks)));
        })
        .expect(200)
        .expect("Content-Type", contentType);

      expect(response.body.length).toBeGreaterThan(100);
    });

    it("⛔ 남의 공장 단말은 401 이다", async () => {
      const lotId = await newProductionLot("RENDITION_FOREIGN", "NORMAL", "ACTIVE", false);
      const issued = await issueProductionLot(lotId).expect(201);
      const logId = issued.body.items[0].documentIssueLogId;
      const foreignPlant = await prisma.plant.create({
        data: {
          legal_entity_id: (await prisma.plant.findUniqueOrThrow({
            where: { plant_id: plantId },
          })).legal_entity_id,
          plant_code: `${PREFIX}-FOREIGN`,
          plant_name: "남의 공장",
          timezone_code: "Asia/Seoul",
        },
      });

      await request(app.getHttpServer())
        .get(`/api/app/document-issues/${String(logId)}/rendition?format=png`)
        .set("Authorization", `Bearer ${await popToken(foreignPlant.plant_id)}`)
        .expect(401);
    });
  });

  /**
   * 위치 라벨은 랙에 붙여 관리웹 화면에서 찍는다 — POP 단말이 아니라 `cookie` 로 인증한다.
   * 모든 `locationIds` 는 앞선 스위트에서 이미 한 번씩 발행됐으므로, 여기서 다시 발행하려면
   * 재발행 사유(`REASON`)가 필요하다.
   */
  describe("위치 라벨 렌디션", () => {
    const READABLE_NAME = `${PREFIX}_LOC_READABLE`;
    // ⚠ describe 본문은 `beforeAll` 보다 먼저(동기로) 도는데, 그때는 `locationIds` 가 아직
    //   비어 있다 — 그래서 인덱싱은 `beforeAll` 안에서 한다.
    let locationId: bigint;
    let warehouseCode: string;
    let locationCode: string;

    beforeAll(async () => {
      locationId = locationIds[3];
      const location = await prisma.location.update({
        where: { location_id: locationId },
        data: { location_name: READABLE_NAME },
        select: { location_code: true, warehouse: { select: { warehouse_code: true } } },
      });
      locationCode = location.location_code;
      warehouseCode = location.warehouse.warehouse_code;
    });

    async function issueLocationLabel(suffix: string): Promise<number> {
      const response = await issue([locationId], {
        remarks: `${PREFIX}_LOC_${suffix}`,
        reissueReasonCode: REASON,
      }).expect(201);
      return response.body.items[0].documentIssueLogId;
    }

    function renditionBytes(logId: number, format: "png" | "tspl"): request.Test {
      return request(app.getHttpServer())
        .get(`/api/app/document-issues/${String(logId)}/rendition?format=${format}`)
        .set("Cookie", cookie)
        .buffer(true)
        .parse((stream, callback) => {
          const chunks: Buffer[] = [];
          stream.on("data", (chunk: Buffer) => chunks.push(chunk));
          stream.on("end", () => callback(null, Buffer.concat(chunks)));
        });
    }

    it("⭐ 위치 라벨을 png 로 받는다", async () => {
      const logId = await issueLocationLabel("PNG");

      const response = await renditionBytes(logId, "png")
        .expect(200)
        .expect("Content-Type", /image\/png/);

      expect(response.body.length).toBeGreaterThan(0);
      expect((response.body as Buffer).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    });

    it("⭐ 위치 라벨을 tspl 로 받는다", async () => {
      const logId = await issueLocationLabel("TSPL");

      const response = await renditionBytes(logId, "tspl")
        .expect(200)
        .expect("Content-Type", /application\/vnd\.tspl/);

      expect((response.body as Buffer).toString("ascii").startsWith("SIZE ")).toBe(true);
    });

    it("⭐ QR 에 창고코드/위치코드 가 실린다", async () => {
      const logId = await issueLocationLabel("QR");

      const response = await renditionBytes(logId, "tspl").expect(200);
      const text = (response.body as Buffer).toString("ascii");
      const qrLine = text.split("\r\n").find((line) => line.startsWith("QRCODE "));

      expect(qrLine).toBeDefined();
      expect(qrLine).toContain(`"${warehouseCode}/${locationCode}"`);
    });

    // 영문은 권고일 뿐이라 한글 이름도 막지 않는다 — 프린터에서 그 줄만 깨지고, 라벨의 일
    // (QR·코드로 위치를 특정하는 것)은 그대로 된다.
    it("⭐ 위치명이 한글이어도 발행·인쇄된다 — 영문은 권고이지 제약이 아니다", async () => {
      const logId = await issueLocationLabel("KOREAN");
      await prisma.location.update({
        where: { location_id: locationId },
        data: { location_name: "한글위치명" },
      });

      try {
        const response = await renditionBytes(logId, "tspl")
          .expect(200)
          .expect("Content-Type", /application\/vnd\.tspl/);

        // 서버가 값을 뭉개지 않았는지 본다 — `ascii` 인코딩이면 원문 바이트가 사라진다.
        expect((response.body as Buffer).includes(Buffer.from("한글위치명", "utf8"))).toBe(true);
      } finally {
        await prisma.location.update({
          where: { location_id: locationId },
          data: { location_name: READABLE_NAME },
        });
      }
    });
  });

  let terminalSeq = 0;

  /** 그 공장의 POP 단말 하나를 만들고 현재 세대 토큰을 낸다. */
  async function popToken(plant: bigint): Promise<string> {
    terminalSeq += 1;
    const terminal = await prisma.terminal.create({
      data: {
        terminal_code: `${PREFIX}-POP-${terminalSeq}`,
        plant_id: plant,
        terminal_type_code: "POP",
        status_code: "RUNNING",
      },
    });
    return app.get(JwtService).sign({
      sub: Number(terminal.terminal_id),
      typ: "terminal",
      tv: terminal.token_version,
      terminalCode: terminal.terminal_code,
      plantId: Number(plant),
    });
  }

  function issueProductionLot(lotId: bigint): request.Test {
    return request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", cookie)
      .set("Idempotency-Key", newKey())
      .send({
        documentTypeCode: "PRODUCTION_LOT_LABEL",
        targets: [{ targetTypeCode: "LOT", targetId: Number(lotId) }],
        remarks: `${PREFIX}_PRODUCTION_LOT`,
      });
  }

  let productionLotSeq = 0;

  async function newProductionLot(
    suffix: string,
    statusCode: string,
    lifecycleStatusCode: string | null,
    completed: boolean,
  ): Promise<bigint> {
    productionLotSeq += 1;
    const row = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}_PLOT_${productionLotSeq}`,
        item_id: itemId,
        lot_type_code: "PRODUCTION",
        plant_id: plantId,
        initial_qty: 100,
        uom_id: uomId,
        // 생산 LOT 은 W/O 를 원천으로 난다 — 라벨 자격은 원천 유형을 보지 않지만 실제 모양대로 둔다.
        source_type_code: "WORK_ORDER",
        source_id: plantId,
        status_code: statusCode,
        ...(lifecycleStatusCode === null
          ? {}
          : { lifecycle_status_code: lifecycleStatusCode }),
        ...(completed ? { completed_at: new Date() } : {}),
        remarks: suffix,
      },
    });
    return row.lot_id;
  }

  function issue(
    targetIds: bigint[],
    options: {
      key?: string;
      reissueReasonCode?: string;
      printerName?: string;
      remarks: string;
    },
  ): request.Test {
    return request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", cookie)
      .set("Idempotency-Key", options.key ?? newKey())
      .send({
        documentTypeCode: "LOCATION_LABEL",
        targets: targetIds.map((targetId) => ({
          targetTypeCode: "LOCATION",
          targetId: Number(targetId),
        })),
        ...(options.reissueReasonCode === undefined
          ? {}
          : { reissueReasonCode: options.reissueReasonCode }),
        ...(options.printerName === undefined
          ? {}
          : { printerName: options.printerName }),
        remarks: options.remarks,
      });
  }

  function newKey(): string {
    const key = randomUUID();
    keys.push(key);
    return key;
  }

  function countIssues(targetId: bigint): Promise<number> {
    return prisma.document_issue_log.count({
      where: {
        document_type_code: "LOCATION_LABEL",
        target_type_code: "LOCATION",
        target_id: targetId,
      },
    });
  }

  function issueCertificate(resultId: number, suffix: string): request.Test {
    return request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", cookie)
      .set("Idempotency-Key", newKey())
      .send({
        documentTypeCode: "CERTIFICATE_OF_ANALYSIS",
        targets: [{ targetTypeCode: "INSPECTION_RESULT", targetId: resultId }],
        remarks: `${PREFIX}_COA_${suffix}`,
      });
  }

  function confirmInspection(resultId: number): request.Test {
    return request(app.getHttpServer())
      .post(`/api/quality/inspection-results/${resultId}:confirm`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", newKey())
      .set("If-Match", "1")
      .send({ overallJudgmentCode: "ACCEPTED" });
  }

  function certificateCount(resultId: number): Promise<number> {
    return prisma.document_issue_log.count({
      where: {
        document_type_code: "CERTIFICATE_OF_ANALYSIS",
        target_type_code: "INSPECTION_RESULT",
        target_id: resultId,
      },
    });
  }

  interface GoodsIssueFixture {
    goodsIssueId: number;
    goodsIssueLineId: bigint;
    replacementLotId: bigint;
    versionNo: number;
  }

  function issueGoodsIssueLine(
    fixture: GoodsIssueFixture,
    suffix: string,
  ): request.Test {
    return request(app.getHttpServer())
      .post(PATH)
      .set("Cookie", cookie)
      .set("Idempotency-Key", newKey())
      .send({
        documentTypeCode: "GOODS_ISSUE_QR",
        targets: [
          {
            targetTypeCode: "GOODS_ISSUE_LINE",
            targetId: Number(fixture.goodsIssueLineId),
          },
        ],
        remarks: `${PREFIX}_GI_${suffix}`,
      });
  }

  function replaceGoodsIssueLine(fixture: GoodsIssueFixture): request.Test {
    return request(app.getHttpServer())
      .put(`/api/logistics/goods-issues/${fixture.goodsIssueId}/lines`)
      .set("Cookie", cookie)
      .set("Idempotency-Key", newKey())
      .set("If-Match", String(fixture.versionNo))
      .send({
        items: [
          {
            goodsIssueLineId: Number(fixture.goodsIssueLineId),
            itemId: Number(itemId),
            lotId: Number(fixture.replacementLotId),
            issueQty: 10,
            uomId: Number(uomId),
            sourceLocationId: Number(locationIds[0]),
          },
        ],
      });
  }

  function goodsIssueDocumentCount(lineId: bigint): Promise<number> {
    return prisma.document_issue_log.count({
      where: {
        document_type_code: "GOODS_ISSUE_QR",
        target_type_code: "GOODS_ISSUE_LINE",
        target_id: lineId,
      },
    });
  }

  async function newPostedGoodsIssue(
    suffix: string,
  ): Promise<GoodsIssueFixture> {
    const fixture = await newRegisteredGoodsIssue(suffix);
    const posted = await prisma.goods_issue.update({
      where: { goods_issue_id: BigInt(fixture.goodsIssueId) },
      data: { status_code: "POSTED" },
      select: { version_no: true },
    });
    return { ...fixture, versionNo: posted.version_no };
  }

  async function newRegisteredGoodsIssue(
    suffix: string,
  ): Promise<GoodsIssueFixture> {
    const [originalLot, replacementLot] = await Promise.all([
      newLot(`GI_${suffix}_ORIGINAL`),
      newLot(`GI_${suffix}_REPLACEMENT`),
    ]);
    const header = await prisma.goods_issue.create({
      data: {
        goods_issue_no: `${PREFIX}_GI_${suffix}`,
        issue_type_code: "OTHER",
        source_document_type_code: "GOODS_RECEIPT",
        source_document_id: plantId,
        source_warehouse_id: warehouseId,
        issued_at: new Date(),
        status_code: "REGISTERED",
      },
    });
    const line = await prisma.goods_issue_line.create({
      data: {
        goods_issue_id: header.goods_issue_id,
        line_no: 1,
        item_id: itemId,
        lot_id: originalLot,
        issue_qty: 10,
        uom_id: uomId,
        source_location_id: locationIds[0],
      },
    });
    return {
      goodsIssueId: Number(header.goods_issue_id),
      goodsIssueLineId: line.goods_issue_line_id,
      replacementLotId: replacementLot,
      versionNo: header.version_no,
    };
  }

  async function newLot(suffix: string): Promise<bigint> {
    return (
      await prisma.lot.create({
        data: {
          lot_no: `${PREFIX}_${suffix}`,
          item_id: itemId,
          lot_type_code: "RAW_MATERIAL",
          plant_id: plantId,
          initial_qty: 100,
          uom_id: uomId,
          source_type_code: "INBOUND_RECEIPT_LINE",
          source_id: plantId,
          status_code: "NORMAL",
        },
      })
    ).lot_id;
  }

  async function newConfirmableCoa(suffix: string): Promise<{
    resultId: number;
    lotId: bigint;
  }> {
    const lot = await prisma.lot.create({
      data: {
        lot_no: `${PREFIX}_COA_LOT_${suffix}`,
        item_id: itemId,
        lot_type_code: "RAW_MATERIAL",
        plant_id: plantId,
        initial_qty: 100,
        uom_id: uomId,
        source_type_code: "INBOUND_RECEIPT_LINE",
        source_id: plantId,
        status_code: "INSPECTION_PENDING",
      },
    });
    const inspectionRequest = await prisma.inspection_request.create({
      data: {
        inspection_request_no: `${PREFIX}_COA_REQ_${suffix}`,
        inspection_type_code: "IQC",
        target_type_code: "LOT",
        target_id: lot.lot_id,
        item_id: itemId,
        lot_id: lot.lot_id,
        target_qty: 100,
        uom_id: uomId,
        status_code: "REQUESTED",
        requested_at: new Date(),
      },
    });
    const result = await prisma.inspection_result.create({
      data: {
        inspection_result_no: `${PREFIX}_COA_RES_${suffix}`,
        inspection_request_id: inspectionRequest.inspection_request_id,
        inspected_qty: 100,
        accepted_qty: 100,
        uom_id: uomId,
        inspector_id: workerId,
        inspected_at: new Date(),
        status_code: "DRAFT",
        idempotency_key: `${PREFIX}_COA_IDEM_${suffix}`,
      },
    });
    return { resultId: Number(result.inspection_result_id), lotId: lot.lot_id };
  }

  async function blockInspectionResult(resultId: number): Promise<{
    release: () => void;
    done: Promise<void>;
  }> {
    let unlock = (): void => undefined;
    let locked = (): void => undefined;
    const released = new Promise<void>((resolve) => (unlock = resolve));
    const acquired = new Promise<void>((resolve) => (locked = resolve));
    let releasedOnce = false;
    const done = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT inspection_result_id FROM quality.inspection_result
        WHERE inspection_result_id=${BigInt(resultId)}
        FOR UPDATE`);
      locked();
      await released;
    });
    await acquired;
    return {
      release: () => {
        if (releasedOnce) return;
        releasedOnce = true;
        unlock();
      },
      done,
    };
  }

  async function blockGoodsIssue(goodsIssueId: number): Promise<{
    release: () => void;
    done: Promise<void>;
  }> {
    let unlock = (): void => undefined;
    let locked = (): void => undefined;
    const released = new Promise<void>((resolve) => (unlock = resolve));
    const acquired = new Promise<void>((resolve) => (locked = resolve));
    let releasedOnce = false;
    const done = prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`
        SELECT goods_issue_id FROM logistics.goods_issue
        WHERE goods_issue_id=${BigInt(goodsIssueId)}
        FOR UPDATE`);
      locked();
      await released;
    });
    await acquired;
    return {
      release: () => {
        if (releasedOnce) return;
        releasedOnce = true;
        unlock();
      },
      done,
    };
  }

  async function waitForBlockedQuery(pattern: string): Promise<void> {
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      const rows = await prisma.$queryRaw<{ waiting: boolean }[]>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity
          WHERE datname=current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type='Lock'
            AND query LIKE ${pattern}
        ) AS waiting`);
      if (rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`잠금 대기를 관측하지 못했습니다: ${pattern}`);
  }

  async function makeFixture(jwt: JwtService): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({
      orderBy: { plant_id: "asc" },
    });
    plantId = plant.plant_id;
    const businessUnit = await prisma.business_unit.findFirstOrThrow({
      orderBy: { business_unit_id: "asc" },
    });
    const uom = await prisma.uom.create({
      data: { uom_code: `${PREFIX}_UOM`, uom_name: "I-27 CoA 검사 단위" },
    });
    uomId = uom.uom_id;
    itemId = (
      await prisma.item.create({
        data: {
          item_code: `${PREFIX}_ITEM`,
          item_name: "I-27 CoA 검사 품목",
          item_type_code: "FINISHED_GOOD",
          base_uom_id: uomId,
          lot_control_type_code: "LOT",
        },
      })
    ).item_id;
    const warehouse = await prisma.warehouse.create({
      data: {
        plant_id: plant.plant_id,
        business_unit_id:
          plant.business_unit_id ?? businessUnit.business_unit_id,
        warehouse_code: `${PREFIX}_WH`,
        warehouse_name: "I-27 발행 E2E 창고",
        warehouse_type_code: "RAW_MATERIAL",
        management_level_code: "LOCATION",
      },
    });
    warehouseId = warehouse.warehouse_id;
    const user = await prisma.app_user.create({
      data: {
        login_id: `${PREFIX}_USER`,
        user_name: "I-27 발행 E2E 계정",
        status_code: "EMPLOYED",
      },
    });
    userId = user.app_user_id;
    cookie = `${SESSION_COOKIE}=${jwt.sign({
      sub: Number(userId),
      typ: TOKEN_TYPE.SESSION,
    })}`;
    const role = await prisma.role.create({
      data: {
        role_code: `${PREFIX}_ROLE`,
        role_name: "I-27 발행 E2E 역할",
      },
    });
    await prisma.role_permission.createMany({
      data: ["W-06-07", "W-04-03", "W-01-01", "W-01-06"].map(
        (permission_code) => ({ role_id: role.role_id, permission_code }),
      ),
    });
    await prisma.user_role.create({
      data: { app_user_id: userId, role_id: role.role_id },
    });
    workerId = (
      await prisma.worker.create({
        data: {
          worker_no: `${PREFIX}_COA_WORKER`,
          worker_name: "I-27 CoA 경합 검사자",
          business_unit_id: businessUnit.business_unit_id,
          plant_id: plant.plant_id,
          status_code: "EMPLOYED",
        },
      })
    ).worker_id;
    const reasonGroup = await prisma.code_group.findUniqueOrThrow({
      where: { group_code: "REISSUE_REASON" },
    });
    await prisma.code_value.create({
      data: {
        code_group_id: reasonGroup.code_group_id,
        code: REASON,
        code_name: "E2E 재발행",
      },
    });
    const locations = await prisma.location.createManyAndReturn({
      data: Array.from({ length: LOCATION_COUNT }, (_, index) => ({
        warehouse_id: warehouse.warehouse_id,
        location_code: `${PREFIX}_${index}`,
        location_name: `${PREFIX} 위치 ${index}`,
        location_type_code: "STORAGE",
      })),
      select: { location_id: true, location_code: true },
    });
    locationIds = locations
      .sort((left, right) =>
        left.location_code.localeCompare(right.location_code, undefined, {
          numeric: true,
        }),
      )
      .map((location) => location.location_id);
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.idempotency_record.deleteMany({
      where: { idempotency_key: { in: keys } },
    });
    await prisma.document_issue_log.deleteMany({
      where: { remarks: { startsWith: PREFIX } },
    });
    const goodsIssues = await prisma.goods_issue.findMany({
      where: { goods_issue_no: { startsWith: PREFIX } },
      select: { goods_issue_id: true },
    });
    await prisma.goods_issue_line.deleteMany({
      where: {
        goods_issue_id: {
          in: goodsIssues.map((issue) => issue.goods_issue_id),
        },
      },
    });
    await prisma.goods_issue.deleteMany({
      where: {
        goods_issue_id: {
          in: goodsIssues.map((issue) => issue.goods_issue_id),
        },
      },
    });
    const lots = await prisma.lot.findMany({
      where: { lot_no: { startsWith: PREFIX } },
      select: { lot_id: true },
    });
    await prisma.lot_status_event.deleteMany({
      where: { lot_id: { in: lots.map((lot) => lot.lot_id) } },
    });
    await prisma.lot_hold.deleteMany({
      where: { lot_id: { in: lots.map((lot) => lot.lot_id) } },
    });
    await prisma.inspection_result.deleteMany({
      where: { inspection_result_no: { startsWith: PREFIX } },
    });
    await prisma.inspection_request.deleteMany({
      where: { inspection_request_no: { startsWith: PREFIX } },
    });
    await prisma.lot.deleteMany({
      where: { lot_id: { in: lots.map((lot) => lot.lot_id) } },
    });
    await prisma.worker.deleteMany({
      where: { worker_no: { startsWith: PREFIX } },
    });
    await prisma.item.deleteMany({
      where: { item_code: { startsWith: PREFIX } },
    });
    await prisma.uom.deleteMany({
      where: { uom_code: { startsWith: PREFIX } },
    });
    // D5 회귀가 만든 POP 단말과 「남의 공장」을 걷는다.
    await prisma.terminal.deleteMany({
      where: { terminal_code: { startsWith: PREFIX } },
    });
    await prisma.plant.deleteMany({
      where: { plant_code: { startsWith: PREFIX } },
    });
    await prisma.location.deleteMany({
      where: { location_code: { startsWith: PREFIX } },
    });
    await prisma.warehouse.deleteMany({
      where: { warehouse_code: { startsWith: PREFIX } },
    });
    await prisma.code_value.deleteMany({
      where: { code: REASON, code_group: { group_code: "REISSUE_REASON" } },
    });
    await prisma.user_role.deleteMany({
      where: { app_user: { login_id: { startsWith: PREFIX } } },
    });
    await prisma.role_permission.deleteMany({
      where: { role: { role_code: { startsWith: PREFIX } } },
    });
    await prisma.role.deleteMany({
      where: { role_code: { startsWith: PREFIX } },
    });
    await prisma.app_user.deleteMany({
      where: { login_id: { startsWith: PREFIX } },
    });
  }
});
