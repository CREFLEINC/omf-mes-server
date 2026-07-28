import { ConflictException, Injectable } from '@nestjs/common';
import { partner, partner_role, Prisma } from '@prisma/client';

import { PageDto } from '../../common/dto/page.dto';
import { PrismaService } from '../../prisma/prisma.service';
import { CodeValidatorService } from '../common-code/code-validator.service';
import { baseWhere, createStamp, orConflict, orFail, updateStamp } from '../common/master-crud';
import {
  AddPartnerRoleDto,
  CreatePartnerDto,
  PartnerQueryDto,
  UpdatePartnerDto,
} from './partner.dto';

@Injectable()
export class PartnerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly codes: CodeValidatorService,
  ) {}

  async create(dto: CreatePartnerDto, actor?: bigint): Promise<partner> {
    const roles = dto.roleTypeCodes ?? [];
    await this.codes.assertAllValid(roles.map((role) => ['PARTNER_ROLE_TYPE', role]));

    orConflict(
      await this.prisma.partner.findUnique({ where: { partner_code: dto.partnerCode } }),
      `이미 존재하는 거래처입니다: ${dto.partnerCode}`,
    );

    const uniqueRoles = [...new Set(roles)];

    return this.prisma.partner.create({
      data: {
        partner_code: dto.partnerCode,
        partner_name: dto.partnerName,
        country_code: dto.countryCode ?? null,
        erp_partner_code: dto.erpPartnerCode ?? null,
        is_active: dto.isActive ?? true,
        ...createStamp(actor),
        partner_role: {
          create: uniqueRoles.map((role) => ({ role_type_code: role, created_by: actor })),
        },
      },
    });
  }

  async findAll(query: PartnerQueryDto): Promise<PageDto<partner>> {
    const extra = query.roleTypeCode
      ? { partner_role: { some: { role_type_code: query.roleTypeCode } } }
      : {};
    const where = baseWhere(query, [
      'partner_code',
      'partner_name',
      'erp_partner_code',
    ], extra) as Prisma.partnerWhereInput;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.partner.findMany({
        where,
        orderBy: { partner_code: 'asc' },
        skip: query.skip,
        take: query.size,
      }),
      this.prisma.partner.count({ where }),
    ]);
    return new PageDto(items, total, query.page, query.size);
  }

  async findOne(partnerCode: string) {
    const found = await this.prisma.partner.findUnique({
      where: { partner_code: partnerCode },
      include: { partner_role: { orderBy: { role_type_code: 'asc' } } },
    });
    return orFail(found, `거래처(${partnerCode})`);
  }

  async update(partnerCode: string, dto: UpdatePartnerDto, actor?: bigint): Promise<partner> {
    const found = await this.getPartner(partnerCode);

    return this.prisma.partner.update({
      where: { partner_id: found.partner_id },
      data: {
        partner_name: dto.partnerName,
        country_code: dto.countryCode,
        erp_partner_code: dto.erpPartnerCode,
        is_active: dto.isActive,
        ...updateStamp(actor),
      },
    });
  }

  /**
   * 마스터 참조(외부창고·품목 외부코드)만 검사한다.
   * 구매발주·출하 등 트랜잭션 참조는 해당 모듈과 함께 붙인다.
   */
  async deactivate(partnerCode: string, actor?: bigint): Promise<void> {
    const found = await this.getPartner(partnerCode);

    const [warehouses, externalCodes] = await this.prisma.$transaction([
      this.prisma.warehouse.count({ where: { partner_id: found.partner_id, is_active: true } }),
      this.prisma.item_external_code.count({ where: { partner_id: found.partner_id } }),
    ]);
    if (warehouses + externalCodes > 0) {
      throw new ConflictException(
        `참조 중이라 비활성화할 수 없습니다: ${partnerCode} ` +
          `(외부창고 ${warehouses}·품목 외부코드 ${externalCodes})`,
      );
    }

    await this.prisma.partner.update({
      where: { partner_id: found.partner_id },
      data: { is_active: false, ...updateStamp(actor) },
    });
  }

  async addRole(
    partnerCode: string,
    dto: AddPartnerRoleDto,
    actor?: bigint,
  ): Promise<partner_role> {
    const found = await this.getPartner(partnerCode);
    await this.codes.assertValid('PARTNER_ROLE_TYPE', dto.roleTypeCode);

    orConflict(
      await this.prisma.partner_role.findUnique({
        where: {
          partner_id_role_type_code: {
            partner_id: found.partner_id,
            role_type_code: dto.roleTypeCode,
          },
        },
      }),
      `이미 부여된 역할입니다: ${partnerCode}.${dto.roleTypeCode}`,
    );

    return this.prisma.partner_role.create({
      data: {
        partner_id: found.partner_id,
        role_type_code: dto.roleTypeCode,
        created_by: actor,
      },
    });
  }

  async findRoles(partnerCode: string): Promise<partner_role[]> {
    const found = await this.getPartner(partnerCode);
    return this.prisma.partner_role.findMany({
      where: { partner_id: found.partner_id },
      orderBy: { role_type_code: 'asc' },
    });
  }

  /** 단순 매핑이라 비활성 플래그가 없다. */
  async removeRole(partnerCode: string, roleTypeCode: string): Promise<void> {
    const found = await this.getPartner(partnerCode);
    const role = orFail(
      await this.prisma.partner_role.findUnique({
        where: {
          partner_id_role_type_code: { partner_id: found.partner_id, role_type_code: roleTypeCode },
        },
      }),
      `역할(${partnerCode}.${roleTypeCode})`,
    );

    await this.prisma.partner_role.delete({
      where: { partner_role_id: role.partner_role_id },
    });
  }

  private async getPartner(partnerCode: string): Promise<partner> {
    return orFail(
      await this.prisma.partner.findUnique({ where: { partner_code: partnerCode } }),
      `거래처(${partnerCode})`,
    );
  }
}
