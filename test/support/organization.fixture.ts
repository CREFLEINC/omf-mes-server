import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * e2e 가 쓰는 최소 조직 계층 — 법인 → 사업부 → 공장.
 *
 * 시드는 공통코드·채번규칙·역할만 만들고 조직은 만들지 않는다. 이미 있는 행을 찾아
 * 쓰면 개발자 DB 에서만 통과하고 깨끗한 CI 에서 깨지므로(#12) 테스트가 자기 것을 만든다.
 *
 * 창고·로케이션·부서 등 앞으로 올 마스터가 모두 이 계층을 FK 로 요구한다.
 */
export type Organization = {
  legalEntityId: bigint;
  businessUnitId: bigint;
  plantId: bigint;
};

export async function createOrganization(
  prisma: PrismaService,
  prefix: string,
): Promise<Organization> {
  const legalEntity = await prisma.legal_entity.upsert({
    where: { legal_entity_code: `${prefix}-LE` },
    update: {},
    create: {
      legal_entity_code: `${prefix}-LE`,
      legal_entity_name: 'e2e 법인',
      country_code: 'VNM',
      timezone_code: 'Asia/Ho_Chi_Minh',
    },
  });

  const businessUnit = await prisma.business_unit.upsert({
    where: {
      legal_entity_id_business_unit_code: {
        legal_entity_id: legalEntity.legal_entity_id,
        business_unit_code: `${prefix}-BU`,
      },
    },
    update: {},
    create: {
      legal_entity_id: legalEntity.legal_entity_id,
      business_unit_code: `${prefix}-BU`,
      business_unit_name: 'e2e 사업부',
    },
  });

  const plant = await prisma.plant.upsert({
    where: {
      legal_entity_id_plant_code: {
        legal_entity_id: legalEntity.legal_entity_id,
        plant_code: `${prefix}-PLT`,
      },
    },
    update: {},
    create: {
      legal_entity_id: legalEntity.legal_entity_id,
      business_unit_id: businessUnit.business_unit_id,
      plant_code: `${prefix}-PLT`,
      plant_name: 'e2e 공장',
      timezone_code: 'Asia/Ho_Chi_Minh',
    },
  });

  return {
    legalEntityId: legalEntity.legal_entity_id,
    businessUnitId: businessUnit.business_unit_id,
    plantId: plant.plant_id,
  };
}

/** FK 순서대로 지운다 — 공장 → 사업부 → 법인. 하위 마스터는 호출부가 먼저 지운다. */
export async function deleteOrganization(prisma: PrismaService, prefix: string): Promise<void> {
  await prisma.plant.deleteMany({ where: { plant_code: { startsWith: prefix } } });
  await prisma.business_unit.deleteMany({ where: { business_unit_code: { startsWith: prefix } } });
  await prisma.legal_entity.deleteMany({ where: { legal_entity_code: { startsWith: prefix } } });
}
