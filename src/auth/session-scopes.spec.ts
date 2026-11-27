import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from './session.service';

/** omf-all-around#336 — 세션 `scopes` 가 비면 「제한 없음」이라, 범위 줄은 하나도 버리지 않는다. */
describe('SessionService.build — 데이터 범위', () => {
  const scopesOf = async (rows: object[]) => {
    const prisma = {
      app_user: {
        findFirst: jest.fn().mockResolvedValue({
          app_user_id: 1001n,
          login_id: 'SYN-LOGIN-01',
          user_name: '합성 사용자',
          department_id: null,
          user_credential: null,
          user_data_scope: rows,
          user_role: [],
          worker: [],
        }),
      },
    } as unknown as PrismaService;
    const session = await new SessionService(prisma).build(1001, null);
    return session?.scopes;
  };
  const row = (over: object) => ({
    business_unit_id: null,
    plant_id: null,
    legal_entity_id: null,
    plant: null,
    legal_entity: null,
    ...over,
  });

  it('줄이 없으면 빈 목록이다 — 제한 없음', async () => {
    await expect(scopesOf([])).resolves.toEqual([]);
  });

  it('사업부 · 공장 줄은 그대로 싣는다', async () => {
    await expect(
      scopesOf([row({ business_unit_id: 1n }), row({ business_unit_id: 1n, plant_id: 4n, plant: { business_unit_id: 1n } })]),
    ).resolves.toEqual([{ businessUnitId: 1 }, { businessUnitId: 1, plantId: 4 }]);
  });

  it('공장만 지정한 줄은 그 공장의 사업부를 채워 싣는다', async () => {
    await expect(scopesOf([row({ plant_id: 4n, plant: { business_unit_id: 2n } })])).resolves.toEqual([
      { businessUnitId: 2, plantId: 4 },
    ]);
  });

  it('법인만 지정한 줄은 그 법인의 사업부 전부로 푼다', async () => {
    await expect(
      scopesOf([
        row({
          legal_entity_id: 9n,
          legal_entity: { business_unit: [{ business_unit_id: 1n }, { business_unit_id: 2n }] },
        }),
      ]),
    ).resolves.toEqual([{ businessUnitId: 1 }, { businessUnitId: 2 }]);
  });

  it('풀 사업부가 없는 법인 줄도 「제한 없음」이 되지 않는다', async () => {
    await expect(
      scopesOf([row({ legal_entity_id: 9n, legal_entity: { business_unit: [] } })]),
    ).resolves.toEqual([{ businessUnitId: 0 }]);
  });
});
