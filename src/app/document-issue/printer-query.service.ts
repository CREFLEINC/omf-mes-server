import { HttpStatus, Injectable } from "@nestjs/common";

import { ContractException, ERROR_CODE, field } from "../../common/errors";
import { PrismaService } from "../../prisma/prisma.service";

export interface PrinterListQuery {
  terminalId?: number;
  documentTypeCode?: string;
}

export interface PrinterView {
  printerName: string;
  displayName: string;
  status: "READY" | "BUSY" | "OFFLINE" | "ERROR";
  statusMessage: string | null;
  isDefault: boolean;
  supportedDocumentTypeCodes: string[];
}

export interface PrinterListResponse {
  items: PrinterView[];
}

const STATUS = new Set<PrinterView["status"]>([
  "READY",
  "BUSY",
  "OFFLINE",
  "ERROR",
]);

@Injectable()
export class PrinterQueryService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    query: PrinterListQuery,
    requestTerminalId: bigint | null,
  ): Promise<PrinterListResponse> {
    const terminalId = terminalIdOf(query.terminalId, requestTerminalId);
    if (terminalId === null) return { items: [] };

    const rows = await this.prisma.terminal_printer.findMany({
      where: {
        terminal_id: terminalId,
        terminal: { is_active: true },
        printer: { is_active: true },
        ...(query.documentTypeCode === undefined
          ? {}
          : {
              supported_document_type_codes: {
                has: query.documentTypeCode,
              },
            }),
      },
      select: {
        is_default: true,
        supported_document_type_codes: true,
        printer: {
          select: {
            printer_code: true,
            printer_name: true,
            status_code: true,
            status_message: true,
          },
        },
      },
      orderBy: [{ is_default: "desc" }, { printer: { printer_code: "asc" } }],
    });
    return {
      items: rows.map((row) => ({
        printerName: row.printer.printer_code,
        displayName: row.printer.printer_name,
        status: statusOf(row.printer.status_code),
        statusMessage: row.printer.status_message,
        isDefault: row.is_default,
        supportedDocumentTypeCodes: row.supported_document_type_codes,
      })),
    };
  }
}

function terminalIdOf(
  explicit: number | undefined,
  requestTerminalId: bigint | null,
): bigint | null {
  if (explicit === undefined) return requestTerminalId;
  if (!Number.isSafeInteger(explicit) || explicit <= 0) {
    throw new ContractException(HttpStatus.BAD_REQUEST, [
      field(
        "terminalId",
        ERROR_CODE.RANGE,
        "단말 식별자 범위가 올바르지 않습니다.",
      ),
    ]);
  }
  return BigInt(explicit);
}

function statusOf(value: string | null): PrinterView["status"] {
  if (value === null) return "OFFLINE";
  if (!STATUS.has(value as PrinterView["status"])) {
    throw new Error(`Stored printer status is invalid: ${value}`);
  }
  return value as PrinterView["status"];
}
