import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";

import { Contract } from "../../common/contract";
import { IdempotencyService } from "../../common/idempotency";
import { ifMatchVersion, setEtag } from "../../common/optimistic-lock";
import { NotificationSubscriptionReplaceInput } from "./notification-recipient-rules";
import { NotificationSubscriptionService } from "./notification-subscription.service";
import { notificationWriteContext } from "./notification-write-context";

@Controller("app")
export class NotificationSubscriptionController {
  constructor(
    private readonly subscriptions: NotificationSubscriptionService,
    private readonly idempotency: IdempotencyService,
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

  @Put("notification-subscriptions")
  @Contract("PUT /app/notification-subscriptions")
  async replace(
    @Req() request: Request,
    @Query("eventCode") eventCode: string,
    @Body() input: NotificationSubscriptionReplaceInput,
    @Res() response: Response,
  ): Promise<void> {
    const version = ifMatchVersion(request);
    if (version === undefined)
      throw new Error("If-Match가 없는데 계약 가드를 통과했습니다.");
    const context = notificationWriteContext(request, HttpStatus.OK);
    const outcome = await this.idempotency.run(context, (tx) =>
      this.subscriptions.replaceWithin(tx, eventCode, version, input),
    );
    response
      .status(outcome.status)
      .type("application/json")
      .end(JSON.stringify(outcome.body));
  }
}
