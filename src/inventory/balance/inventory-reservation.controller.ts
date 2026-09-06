import { Controller, Get, Query } from '@nestjs/common';

import { Contract } from '../../common/contract';
import {
  InventoryReservationService,
  ReservationQuery,
  ReservationResponse,
} from './inventory-reservation.service';

/** 재고 예약 목록. 계약이 403 을 선언하지 않아 권한표에 없다(조회 전용 · 쓰기 경로 0건). */
@Controller('inventory/reservations')
export class InventoryReservationController {
  constructor(private readonly reservations: InventoryReservationService) {}

  @Get()
  @Contract('GET /inventory/reservations')
  list(@Query() query: ReservationQuery): Promise<ReservationResponse> {
    return this.reservations.list(query);
  }
}
