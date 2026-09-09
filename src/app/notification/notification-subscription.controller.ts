import { Controller, Get, HttpStatus, Query, Res } from "@nestjs/common";
import type { Response } from "express";

import { Contract } from "../../common/contract";
import { setEtag } from "../../common/optimistic-lock";
import { NotificationSubscriptionService } from "./notification-subscription.service";

@Controller("app")
export class NotificationSubscriptionController {
  constructor(
    private readonly subscriptions: NotificationSubscriptionService,
  ) {}

  @Get("notification-subscriptions")
  @Contract("GET /app/notification-subscriptions")
  async list(
    @Query("eventCode") eventCode: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const result = await this.subscriptions.list(eventCode);
    if (result.versionNo !== undefined) setEtag(response, result.versionNo);
    response
      .status(HttpStatus.OK)
      .type("application/json")
      .end(JSON.stringify({ items: result.items }));
  }
}
