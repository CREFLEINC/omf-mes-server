import { ContractException } from "../../common/errors";
import { PrinterQueryService } from "./printer-query.service";

describe("프린터 조회 (I-27)", () => {
  it("명시 단말을 우선하고 활성 단말·프린터와 지원 문서만 기본/코드 순으로 조회한다", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PrinterQueryService({
      terminal_printer: { findMany },
    } as never);

    await service.list(
      { terminalId: 22, documentTypeCode: "PACKING_LABEL" },
      11n,
    );

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          terminal_id: 22n,
          terminal: { is_active: true },
          printer: { is_active: true },
          supported_document_type_codes: { has: "PACKING_LABEL" },
        },
        orderBy: [{ is_default: "desc" }, { printer: { printer_code: "asc" } }],
      }),
    );
  });

  it("명시 단말이 없으면 검증된 요청 단말을 사용하고 문서 필터를 발명하지 않는다", async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PrinterQueryService({
      terminal_printer: { findMany },
    } as never);

    await service.list({}, 11n);

    expect(findMany.mock.calls[0][0].where).toEqual({
      terminal_id: 11n,
      terminal: { is_active: true },
      printer: { is_active: true },
    });
  });

  it("단말 문맥이 전혀 없으면 전체 프린터를 노출하지 않고 빈 목록을 낸다", async () => {
    const findMany = jest.fn();
    const service = new PrinterQueryService({
      terminal_printer: { findMany },
    } as never);

    await expect(service.list({}, null)).resolves.toEqual({ items: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("명시 매핑값을 그대로 내고 관측값이 없는 상태만 OFFLINE으로 표시한다", async () => {
    const service = new PrinterQueryService({
      terminal_printer: {
        findMany: jest.fn().mockResolvedValue([
          {
            is_default: true,
            supported_document_type_codes: ["PACKING_LABEL"],
            printer: {
              printer_code: "LABEL-A",
              printer_name: "포장 라벨 A",
              status_code: null,
              status_message: null,
            },
          },
          {
            is_default: false,
            supported_document_type_codes: ["DELIVERY_LABEL"],
            printer: {
              printer_code: "LABEL-B",
              printer_name: "출하 라벨 B",
              status_code: "BUSY",
              status_message: "인쇄 중",
            },
          },
        ]),
      },
    } as never);

    await expect(service.list({}, 11n)).resolves.toEqual({
      items: [
        {
          printerName: "LABEL-A",
          displayName: "포장 라벨 A",
          status: "OFFLINE",
          statusMessage: null,
          isDefault: true,
          supportedDocumentTypeCodes: ["PACKING_LABEL"],
        },
        {
          printerName: "LABEL-B",
          displayName: "출하 라벨 B",
          status: "BUSY",
          statusMessage: "인쇄 중",
          isDefault: false,
          supportedDocumentTypeCodes: ["DELIVERY_LABEL"],
        },
      ],
    });
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])(
    "명시 단말 식별자 %s는 DB 변환 전에 RANGE다",
    async (terminalId) => {
      const service = new PrinterQueryService({} as never);
      await expect(service.list({ terminalId }, null)).rejects.toMatchObject({
        errors: [
          expect.objectContaining({ field: "terminalId", code: "RANGE" }),
        ],
      } satisfies Partial<ContractException>);
    },
  );

  it("DB 제약을 벗어난 상태는 계약값으로 조용히 바꾸지 않는다", async () => {
    const service = new PrinterQueryService({
      terminal_printer: {
        findMany: jest.fn().mockResolvedValue([
          {
            is_default: false,
            supported_document_type_codes: [],
            printer: {
              printer_code: "LABEL-X",
              printer_name: "결손 프린터",
              status_code: "UNKNOWN",
              status_message: null,
            },
          },
        ]),
      },
    } as never);

    await expect(service.list({}, 11n)).rejects.toThrow("UNKNOWN");
  });
});
