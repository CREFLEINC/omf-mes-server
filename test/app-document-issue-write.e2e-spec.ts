import { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
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
const LOCATION_COUNT = 1_002;

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
        ]),
      ).toEqual([0, 0, 0, 0]);
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
    const before = await countIssues(locationIds[0]);
    const missing = await issue([locationIds[0]], {
      remarks: `${PREFIX}_MISSING_REASON`,
    }).expect(422);
    expect(validateUnprocessable(missing.body)).toBe(true);
    expect(missing.body.errors).toEqual([
      expect.objectContaining({
        field: "reissueReasonCode",
        code: "REQUIRED",
      }),
    ]);
    expect(await countIssues(locationIds[0])).toBe(before);

    const response = await issue([locationIds[0]], {
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
        target_id: locationIds[0],
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

  it("1,000건 배치 중간에 미존재 대상이 있으면 전건 롤백한다", async () => {
    const missing = 8_027_399_999_999;
    const targets = locationIds.slice(2, 1_001);
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
    const targets = locationIds.slice(2, 1_002);
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

  async function makeFixture(jwt: JwtService): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({
      orderBy: { plant_id: "asc" },
    });
    const businessUnit = await prisma.business_unit.findFirstOrThrow({
      orderBy: { business_unit_id: "asc" },
    });
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
    await prisma.role_permission.create({
      data: { role_id: role.role_id, permission_code: "W-06-07" },
    });
    await prisma.user_role.create({
      data: { app_user_id: userId, role_id: role.role_id },
    });
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
