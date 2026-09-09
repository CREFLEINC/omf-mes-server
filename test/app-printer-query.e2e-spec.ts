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

const PREFIX = `E2E_I27_PRINTER_${randomUUID().slice(0, 8)}`;
const PATH = "/api/app/printers";

function responseValidator(): ValidateFunction {
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
      "~1app~1printers/get/responses/200/content/application~1json/schema",
  });
}

describe("단말 프린터 조회 (I-27 e2e)", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let cookie: string;
  let firstTerminalId: bigint;
  let secondTerminalId: bigint;
  let firstTerminalToken: string;
  const validateResponse = responseValidator();

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
          prisma.terminal_printer.count({
            where: { terminal: { terminal_code: { startsWith: PREFIX } } },
          }),
          prisma.printer.count({
            where: { printer_code: { startsWith: PREFIX } },
          }),
          prisma.terminal.count({
            where: { terminal_code: { startsWith: PREFIX } },
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

  it("명시 단말의 활성 매핑만 기본 우선·코드 순으로 계약 응답한다", async () => {
    const response = await call({ terminalId: Number(firstTerminalId) }).expect(
      200,
    );

    expect(validateResponse(response.body)).toBe(true);
    expect(validateResponse.errors ?? []).toEqual([]);
    expect(response.body).toEqual({
      items: [
        {
          printerName: `${PREFIX}_B`,
          displayName: "기본 프린터 B",
          status: "OFFLINE",
          statusMessage: null,
          isDefault: true,
          supportedDocumentTypeCodes: ["PACKING_LABEL", "DELIVERY_LABEL"],
        },
        {
          printerName: `${PREFIX}_A`,
          displayName: "프린터 A",
          status: "READY",
          statusMessage: "대기 중",
          isDefault: false,
          supportedDocumentTypeCodes: ["DELIVERY_LABEL"],
        },
      ],
    });
    expect(response.body.items[0]).not.toHaveProperty("connectionUri");
  });

  it("documentTypeCode는 명시 지원 목록으로만 필터링한다", async () => {
    const response = await call({
      terminalId: Number(firstTerminalId),
      documentTypeCode: "PACKING_LABEL",
    }).expect(200);

    expect(
      response.body.items.map(
        (item: { printerName: string }) => item.printerName,
      ),
    ).toEqual([`${PREFIX}_B`]);
  });

  it("질의 단말이 없으면 검증된 bearer 단말을 사용한다", async () => {
    const response = await call({}, firstTerminalToken).expect(200);
    expect(response.body.items).toHaveLength(2);
  });

  it("명시 단말은 bearer 단말보다 우선하고 두 문맥이 없으면 전체 목록을 숨긴다", async () => {
    const explicit = await call(
      { terminalId: Number(secondTerminalId) },
      firstTerminalToken,
    ).expect(200);
    expect(explicit.body.items).toEqual([
      expect.objectContaining({ printerName: `${PREFIX}_D`, isDefault: true }),
    ]);

    const absent = await call().expect(200);
    expect(absent.body).toEqual({ items: [] });
  });

  it("인증·단말 토큰·식별자 결손은 조회 전에 401·400으로 끝난다", async () => {
    await request(app.getHttpServer()).get(PATH).expect(401);
    await call({}, "invalid-token").expect(400);
    await call({ terminalId: 0 }).expect(400);
    await request(app.getHttpServer())
      .get(`${PATH}?terminalId=9007199254740992`)
      .set("Cookie", cookie)
      .expect(400);
  });

  function call(
    query: Record<string, string | number> = {},
    terminalToken?: string,
  ): request.Test {
    const operation = request(app.getHttpServer())
      .get(PATH)
      .set("Cookie", cookie)
      .query(query);
    if (terminalToken !== undefined) {
      operation.set("Authorization", `Bearer ${terminalToken}`);
    }
    return operation;
  }

  async function makeFixture(jwt: JwtService): Promise<void> {
    const plant = await prisma.plant.findFirstOrThrow({
      orderBy: { plant_id: "asc" },
    });
    const user = await prisma.app_user.create({
      data: {
        login_id: `${PREFIX}_USER`,
        user_name: "I-27 프린터 조회 계정",
        status_code: "EMPLOYED",
      },
    });
    cookie = `${SESSION_COOKIE}=${jwt.sign({
      sub: Number(user.app_user_id),
      typ: TOKEN_TYPE.SESSION,
    })}`;
    const terminals = await Promise.all(
      ["T1", "T2"].map((suffix) =>
        prisma.terminal.create({
          data: {
            terminal_code: `${PREFIX}_${suffix}`,
            plant_id: plant.plant_id,
            terminal_type_code: "POP",
            status_code: "ACTIVE",
          },
        }),
      ),
    );
    [firstTerminalId, secondTerminalId] = terminals.map(
      (terminal) => terminal.terminal_id,
    );
    firstTerminalToken = jwt.sign({
      sub: Number(firstTerminalId),
      typ: TOKEN_TYPE.TERMINAL,
      tv: terminals[0].token_version,
    });

    const printers = await Promise.all(
      [
        ["A", "프린터 A", true, "READY", "대기 중"],
        ["B", "기본 프린터 B", true, null, null],
        ["C", "비활성 프린터 C", false, "ERROR", "사용 중지"],
        ["D", "다른 단말 프린터 D", true, "BUSY", "인쇄 중"],
      ].map(([code, name, active, status, message]) =>
        prisma.printer.create({
          data: {
            plant_id: plant.plant_id,
            printer_code: `${PREFIX}_${code}`,
            printer_name: String(name),
            printer_type_code: "LABEL",
            connection_uri: `mock://${String(code).toLowerCase()}`,
            is_active: Boolean(active),
            status_code: status as string | null,
            status_message: message as string | null,
          },
        }),
      ),
    );
    await prisma.terminal_printer.createMany({
      data: [
        {
          terminal_id: firstTerminalId,
          printer_id: printers[0].printer_id,
          supported_document_type_codes: ["DELIVERY_LABEL"],
        },
        {
          terminal_id: firstTerminalId,
          printer_id: printers[1].printer_id,
          is_default: true,
          supported_document_type_codes: ["PACKING_LABEL", "DELIVERY_LABEL"],
        },
        {
          terminal_id: firstTerminalId,
          printer_id: printers[2].printer_id,
          supported_document_type_codes: ["PACKING_LABEL"],
        },
        {
          terminal_id: secondTerminalId,
          printer_id: printers[3].printer_id,
          is_default: true,
          supported_document_type_codes: ["DELIVERY_LABEL"],
        },
      ],
    });
  }

  async function cleanup(): Promise<void> {
    if (!prisma) return;
    await prisma.terminal_printer.deleteMany({
      where: { terminal: { terminal_code: { startsWith: PREFIX } } },
    });
    await prisma.printer.deleteMany({
      where: { printer_code: { startsWith: PREFIX } },
    });
    await prisma.terminal.deleteMany({
      where: { terminal_code: { startsWith: PREFIX } },
    });
    await prisma.app_user.deleteMany({
      where: { login_id: { startsWith: PREFIX } },
    });
  }
});
