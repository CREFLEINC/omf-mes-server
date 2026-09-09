import { PrismaClient } from "@prisma/client";

const PREFIX = "E2E-B-I27-PRINTER";

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
  character_maximum_length: number | null;
}

describe("I-27 프린터·단말 매핑 물리 계약 (e2e)", () => {
  const prisma = new PrismaClient();
  let legalEntityId: bigint;
  let businessUnitId: bigint;
  let plantId: bigint;
  let terminalId: bigint;
  let printerIds: bigint[] = [];

  beforeAll(async () => {
    await cleanup();
    const legalEntity = await prisma.legal_entity.create({
      data: {
        legal_entity_code: PREFIX,
        legal_entity_name: PREFIX,
        country_code: "VN",
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    legalEntityId = legalEntity.legal_entity_id;
    businessUnitId = (
      await prisma.business_unit.create({
        data: {
          business_unit_code: PREFIX,
          business_unit_name: PREFIX,
          legal_entity_id: legalEntityId,
        },
      })
    ).business_unit_id;
    plantId = (
      await prisma.plant.create({
        data: {
          plant_code: PREFIX,
          plant_name: PREFIX,
          legal_entity_id: legalEntityId,
          business_unit_id: businessUnitId,
          timezone_code: "Asia/Ho_Chi_Minh",
        },
      })
    ).plant_id;
    terminalId = (
      await prisma.terminal.create({
        data: {
          terminal_code: PREFIX,
          plant_id: plantId,
          terminal_type_code: "SHOPFLOOR",
          status_code: "ACTIVE",
        },
      })
    ).terminal_id;
    printerIds = (
      await Promise.all(
        ["MAPPED", "UNMAPPED"].map((suffix) =>
          prisma.printer.create({
            data: {
              plant_id: plantId,
              printer_code: `${PREFIX}-${suffix}`,
              printer_name: `${PREFIX} ${suffix}`,
              printer_type_code: "LABEL",
              connection_uri: `mock://${suffix.toLowerCase()}`,
            },
          }),
        ),
      )
    ).map((printer) => printer.printer_id);
    await prisma.terminal_printer.create({
      data: {
        terminal_id: terminalId,
        printer_id: printerIds[0],
        is_default: true,
        supported_document_type_codes: ["MATERIAL_LOT_LABEL", "TOOL_LABEL"],
      },
    });
  });

  afterAll(async () => {
    try {
      await cleanup();
      expect(
        await Promise.all([
          prisma.terminal_printer.count({
            where: { terminal: { terminal_code: PREFIX } },
          }),
          prisma.printer.count({
            where: { printer_code: { startsWith: PREFIX } },
          }),
          prisma.terminal.count({ where: { terminal_code: PREFIX } }),
          prisma.plant.count({ where: { plant_code: PREFIX } }),
          prisma.business_unit.count({ where: { business_unit_code: PREFIX } }),
          prisma.legal_entity.count({ where: { legal_entity_code: PREFIX } }),
        ]),
      ).toEqual([0, 0, 0, 0, 0, 0]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("상태 관측 칸과 명시 매핑 칸은 정본 타입·nullable/default를 갖는다", async () => {
    const printerColumns = await prisma.$queryRaw<Column[]>`
      SELECT column_name,data_type,is_nullable,character_maximum_length
      FROM information_schema.columns
      WHERE table_schema='app' AND table_name='printer'
        AND column_name IN ('status_code','status_message')`;
    expect(printerColumns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          column_name: "status_code",
          data_type: "character varying",
          is_nullable: "YES",
          character_maximum_length: 40,
        }),
        expect.objectContaining({
          column_name: "status_message",
          data_type: "character varying",
          is_nullable: "YES",
          character_maximum_length: 200,
        }),
      ]),
    );

    const mappingColumns = await prisma.$queryRaw<Column[]>`
      SELECT column_name,data_type,is_nullable,character_maximum_length
      FROM information_schema.columns
      WHERE table_schema='app' AND table_name='terminal_printer'`;
    expect(mappingColumns).toHaveLength(10);
    expect(
      mappingColumns.find(
        (column) => column.column_name === "supported_document_type_codes",
      ),
    ).toMatchObject({ data_type: "ARRAY", is_nullable: "NO" });
  });

  it("같은 공장에 있다는 이유만으로 프린터를 단말에 암묵 연결하지 않는다", async () => {
    const mapping = await prisma.terminal_printer.findUniqueOrThrow({
      where: {
        terminal_id_printer_id: {
          terminal_id: terminalId,
          printer_id: printerIds[0],
        },
      },
    });

    expect(mapping).toMatchObject({
      terminal_id: terminalId,
      printer_id: printerIds[0],
      is_default: true,
      supported_document_type_codes: ["MATERIAL_LOT_LABEL", "TOOL_LABEL"],
    });
    expect(
      await prisma.terminal_printer.findMany({
        where: { terminal_id: terminalId },
      }),
    ).toHaveLength(1);
  });

  it("한 단말에는 기본 프린터를 하나만 지정할 수 있다", async () => {
    await expect(
      prisma.terminal_printer.create({
        data: {
          terminal_id: terminalId,
          printer_id: printerIds[1],
          is_default: true,
        },
      }),
    ).rejects.toThrow(
      "Unique constraint failed on the fields: (`terminal_id`)",
    );
  });

  it("알 수 없는 상태와 문서 종류는 저장 단계에서 거부한다", async () => {
    await expect(
      prisma.printer.update({
        where: { printer_id: printerIds[0] },
        data: { status_code: "UNKNOWN" },
      }),
    ).rejects.toThrow("ck_printer_status");

    await expect(
      prisma.terminal_printer.update({
        where: {
          terminal_id_printer_id: {
            terminal_id: terminalId,
            printer_id: printerIds[0],
          },
        },
        data: { supported_document_type_codes: ["UNKNOWN"] },
      }),
    ).rejects.toThrow("ck_terminal_printer_document_types");
  });

  async function cleanup(): Promise<void> {
    await prisma.terminal_printer.deleteMany({
      where: { terminal: { terminal_code: PREFIX } },
    });
    await prisma.printer.deleteMany({
      where: { printer_code: { startsWith: PREFIX } },
    });
    await prisma.terminal.deleteMany({ where: { terminal_code: PREFIX } });
    await prisma.plant.deleteMany({ where: { plant_code: PREFIX } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
  }
});
