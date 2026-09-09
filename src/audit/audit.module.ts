import { Module } from "@nestjs/common";

import { PrismaModule } from "../prisma/prisma.module";
import { AuditEventQueryService } from "./audit-event-query.service";
import { AuditEventController } from "./audit-event.controller";

@Module({
  imports: [PrismaModule],
  controllers: [AuditEventController],
  providers: [AuditEventQueryService],
})
export class AuditModule {}
