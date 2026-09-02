import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { assertUpdated } from '../../common/optimistic-lock';
import { PagedResponse, pagedResponse } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { ReferenceQuery, referencePage, referenceWhere } from '../reference/reference.query';

/** 계약 `Partner` 와 동형. ⛔ 본체는 ERP 수신 마스터라 MES 는 읽기만 한다. */
interface PartnerView {
  partnerId: number;
  partnerCode: string;
  partnerName: string;
  countryCode: string | null;
  erpPartnerCode: string | null;
  isActive: boolean;
}

export interface PartnerQuery extends ReferenceQuery {
  roleTypeCode?: string;
}

type PartnerRow = Prisma.partnerGetPayload<object>;

@Injectable()
export class PartnerService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: PartnerQuery): Promise<PagedResponse<PartnerView>> {
    const page = referencePage(query);
    const where = referenceWhere(query, { code: 'partner_code', name: 'partner_name' }, {
      // 「공급사만」처럼 역할로 고르는 자리다 — 역할 표를 타고 거른다.
      ...(query.roleTypeCode === undefined
        ? {}
        : { partner_role: { some: { role_type_code: query.roleTypeCode } } }),
    });
    const [rows, total] = await Promise.all([
      this.prisma.partner.findMany({
        where,
        orderBy: { partner_code: 'asc' },
        skip: page.skip,
        take: page.take,
      }),
      this.prisma.partner.count({ where }),
    ]);
    return pagedResponse(rows.map(view), total, page);
  }

  /**
   * 「그전에는 목록만 있어 화면의 기본 정보가 «지금 목록에 실려 있는 행»에 매여 있었다 —
   * 목록을 다시 부르거나 검색어를 바꾸면 보고 있던 거래처가 사라진다」(계약 · 2026-08-16 신설).
   */
  async get(partnerId: number): Promise<PartnerView> {
    const row = await this.prisma.partner.findUnique({ where: { partner_id: partnerId } });
    if (!row) throw new NotFoundException('없는 거래처입니다.');
    return view(row);
  }

  async listRoles(partnerId: number): Promise<{ items: string[]; versionNo: number }> {
    const row = await this.prisma.partner.findUnique({
      where: { partner_id: partnerId },
      select: { version_no: true },
    });
    if (!row) throw new NotFoundException('없는 거래처입니다.');
    return { items: await this.readRoles(partnerId), versionNo: row.version_no };
  }

  /**
   * 「목록을 통째로 교체한다 — 역할은 집합이고 (거래처, 역할)이 유일하다」(계약).
   * 어휘 밖 값은 계약이 `enum` 으로 못박아 계약 검증 가드가 거른다(2026-08-16 업무 확정).
   *
   * ⛔ 잠금 축은 «거래처»의 `version_no` 다 — `partner_role` 에 자기 버전이 없다.
   * 「통째로 교체하는 저장이라 보호가 없으면 남이 방금 붙인 역할이 조용히 사라진다」(계약).
   */
  async replaceRoles(
    partnerId: number,
    version: number,
    roleTypeCodes: string[],
    appUserId?: number,
  ): Promise<{ items: string[]; versionNo: number }> {
    // 집합이므로 중복은 «오류가 아니라» 같은 뜻이다 — 접어서 받는다.
    const unique = [...new Set(roleTypeCodes)];

    await this.prisma.$transaction(async (tx) => {
      const bumped = await tx.partner.updateMany({
        where: { partner_id: partnerId, version_no: version },
        data: { version_no: { increment: 1 } },
      });
      if (bumped.count === 0) {
        const exists = await tx.partner.findUnique({
          where: { partner_id: partnerId },
          select: { partner_id: true },
        });
        if (!exists) throw new NotFoundException('없는 거래처입니다.');
        assertUpdated(0);
      }

      await tx.partner_role.deleteMany({ where: { partner_id: partnerId } });
      if (unique.length === 0) return;
      await tx.partner_role.createMany({
        data: unique.map((roleTypeCode) => ({
          partner_id: partnerId,
          role_type_code: roleTypeCode,
          ...(appUserId === undefined ? {} : { created_by: appUserId }),
        })),
      });
    });

    return this.listRoles(partnerId);
  }

  private async readRoles(partnerId: number): Promise<string[]> {
    const rows = await this.prisma.partner_role.findMany({
      where: { partner_id: partnerId },
      orderBy: { role_type_code: 'asc' },
      select: { role_type_code: true },
    });
    return rows.map((row) => row.role_type_code);
  }
}

function view(row: PartnerRow): PartnerView {
  return {
    partnerId: Number(row.partner_id),
    partnerCode: row.partner_code,
    partnerName: row.partner_name,
    countryCode: row.country_code,
    erpPartnerCode: row.erp_partner_code,
    isActive: row.is_active,
  };
}
