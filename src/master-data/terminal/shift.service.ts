import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, shift } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import {
  baseWhere,
  createStamp,
  exactlyOne,
  orConflict,
  updateStamp,
} from '../common/master-crud';
import { OrganizationService } from '../organization/organization.service';
import { CreateShiftDto, ShiftQueryDto, UpdateShiftDto } from './terminal.dto';

/** 응답용 작업조 — 시각을 HH:MM:SS 문자열로 준다. */
export type ShiftView = Omit<shift, 'start_time' | 'end_time'> & {
  start_time: string;
  end_time: string;
};

/**
 * `HH:MM[:SS]` → epoch 날짜의 Date.
 *
 * 정본이 `time` 컬럼이라 Prisma는 DateTime으로 다룬다. Prisma는 time 값을 UTC 기준으로
 * 읽고 쓰므로, 원하는 시:분:초가 그대로 저장되도록 UTC로 만든다.
 */
export function toTimeValue(hhmmss: string): Date {
  const [h, m, s = '00'] = hhmmss.split(':');
  return new Date(Date.UTC(1970, 0, 1, Number(h), Number(m), Number(s)));
}

/** Date → `HH:MM:SS` (UTC 기준 — 저장할 때와 같은 축). */
export function fromTimeValue(value: Date): string {
  return value.toISOString().slice(11, 19);
}

/** 작업조 마스터 — mdm.shift */
@Injectable()
export class ShiftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly org: OrganizationService,
  ) {}

  async create(dto: CreateShiftDto, actor?: bigint): Promise<ShiftView> {
    const plant = await this.org.findPlant(dto.legalEntityCode, dto.plantCode);
    const crossesMidnight = this.resolveCrossesMidnight(
      dto.startTime,
      dto.endTime,
      dto.crossesMidnight,
    );

    orConflict(
      await this.prisma.shift.findUnique({
        where: { plant_id_shift_code: { plant_id: plant.plant_id, shift_code: dto.shiftCode } },
      }),
      `이미 존재하는 작업조입니다: ${dto.plantCode}.${dto.shiftCode}`,
    );

    const created = await this.prisma.shift.create({
      data: {
        plant_id: plant.plant_id,
        shift_code: dto.shiftCode,
        shift_name: dto.shiftName,
        start_time: toTimeValue(dto.startTime),
        end_time: toTimeValue(dto.endTime),
        crosses_midnight: crossesMidnight,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
      },
    });
    return this.toView(created);
  }

  async findAll(query: ShiftQueryDto): Promise<PageDto<ShiftView>> {
    const extra: Record<string, unknown> = {};
    if (query.plantCode) extra.plant = { plant_code: query.plantCode };

    const where = baseWhere(query, ['shift_code', 'shift_name'], extra) as Prisma.shiftWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.shift.findMany({
        where,
        orderBy: { shift_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.shift.count({ where }),
    ]);
    return new PageDto(items.map((row) => this.toView(row)), total, query.page, query.size);
  }

  async findOne(shiftCode: string): Promise<ShiftView> {
    return this.toView(await this.getShift(shiftCode));
  }

  async update(shiftCode: string, dto: UpdateShiftDto, actor?: bigint): Promise<ShiftView> {
    const found = await this.getShift(shiftCode);

    // 한쪽만 보내는 경우가 있어 저장될 최종 상태로 검사한다.
    const startTime = dto.startTime ?? fromTimeValue(found.start_time);
    const endTime = dto.endTime ?? fromTimeValue(found.end_time);
    const crossesMidnight = this.resolveCrossesMidnight(startTime, endTime, dto.crossesMidnight);

    const updated = await this.prisma.shift.update({
      where: { shift_id: found.shift_id },
      data: {
        shift_name: dto.shiftName,
        start_time: toTimeValue(startTime),
        end_time: toTimeValue(endTime),
        crosses_midnight: crossesMidnight,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
    return this.toView(updated);
  }

  /**
   * 비활성화.
   * 작업조 참조처는 전부 트랜잭션(작업지시·작업세션·생산실적)이라 검사하지 않는다.
   */
  async deactivate(shiftCode: string, actor?: bigint): Promise<void> {
    const found = await this.getShift(shiftCode);

    await this.prisma.shift.update({
      where: { shift_id: found.shift_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  /**
   * 자정 넘김 여부는 시각으로 결정된다 — 사용자가 보낸 값과 어긋나면 거부한다.
   * DDL에 제약이 없어 앱에서만 막는다. 22:00~06:00을 crossesMidnight=false로 저장하면
   * 근무 길이가 음수가 되어 이후 집계가 조용히 틀어진다.
   */
  private resolveCrossesMidnight(
    startTime: string,
    endTime: string,
    declared?: boolean,
  ): boolean {
    const start = toTimeValue(startTime).getTime();
    const end = toTimeValue(endTime).getTime();

    if (start === end) {
      throw new BadRequestException(
        '시작 시각과 종료 시각이 같아 근무 길이를 판정할 수 없습니다.',
      );
    }

    const actual = end < start;
    if (declared !== undefined && declared !== actual) {
      throw new BadRequestException(
        actual
          ? '종료 시각이 시작 시각보다 이르므로 crossesMidnight는 true여야 합니다.'
          : '종료 시각이 시작 시각보다 늦으므로 crossesMidnight는 false여야 합니다.',
      );
    }
    return actual;
  }

  private toView(row: shift): ShiftView {
    return {
      ...row,
      start_time: fromTimeValue(row.start_time),
      end_time: fromTimeValue(row.end_time),
    };
  }

  private async getShift(shiftCode: string): Promise<shift> {
    const rows = await this.prisma.shift.findMany({ where: { shift_code: shiftCode }, take: 2 });
    return exactlyOne(rows, '작업조', shiftCode);
  }
}
