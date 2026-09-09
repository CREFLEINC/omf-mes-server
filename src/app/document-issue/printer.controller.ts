import { Controller, Get, Query, Req } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import type { Request } from "express";

import { resolveTerminalId } from "../../auth/terminal-token";
import { Contract } from "../../common/contract";
import { PrismaService } from "../../prisma/prisma.service";
import {
  PrinterListQuery,
  PrinterListResponse,
  PrinterQueryService,
} from "./printer-query.service";

@Controller("app/printers")
export class PrinterController {
  constructor(
    private readonly printers: PrinterQueryService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @Contract("GET /app/printers")
  async list(
    @Req() request: Request,
    @Query() query: PrinterListQuery,
  ): Promise<PrinterListResponse> {
    const requestTerminalId = await resolveTerminalId(
      this.jwt,
      this.prisma,
      request,
    );
    return this.printers.list(query, requestTerminalId);
  }
}
