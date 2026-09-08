import { PrismaClient } from "@prisma/client";

const PREFIX = "E2E-B-I32-SCHEMA";
const STARTED_AT = "2026-09-01T01:02:03.123456Z";
const STARTED_EPOCH_US = "1788224523123456";

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  character_maximum_length: number | null;
  datetime_precision: number | null;
  domain_name: string | null;
}

interface DowntimeSnapshot {
  equipment_downtime_id: bigint;
  equipment_id: bigint;
  breakdown_id: bigint | null;
  downtime_type_code: string | null;
  reason_code: string | null;
  closed_by: bigint | null;
  created_by: bigint | null;
  started_epoch_us: string;
  ended_epoch_us: string | null;
  created_epoch_us: string;
  remarks: string | null;
  recorded_by_worker_no: string | null;
  version_no: number;
}

describe("I-32 P1a 비가동 물리 필드 (e2e)", () => {
  const prisma = new PrismaClient();
  let equipmentId: bigint;
  let actorId: bigint;
  let breakdownId: bigint;

  beforeAll(async () => {
    await cleanup();
    const legal = await prisma.legal_entity.create({
      data: {
        legal_entity_code: PREFIX,
        legal_entity_name: PREFIX,
        country_code: "VN",
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    const business = await prisma.business_unit.create({
      data: {
        business_unit_code: PREFIX,
        business_unit_name: PREFIX,
        legal_entity_id: legal.legal_entity_id,
      },
    });
    const plant = await prisma.plant.create({
      data: {
        plant_code: PREFIX,
        plant_name: PREFIX,
        legal_entity_id: legal.legal_entity_id,
        business_unit_id: business.business_unit_id,
        timezone_code: "Asia/Ho_Chi_Minh",
      },
    });
    equipmentId = (
      await prisma.equipment.create({
        data: {
          equipment_code: PREFIX,
          equipment_name: PREFIX,
          equipment_type_code: "MACHINE",
          status_code: "ACTIVE",
          plant_id: plant.plant_id,
        },
      })
    ).equipment_id;
    actorId = (
      await prisma.app_user.create({
        data: { login_id: PREFIX, user_name: PREFIX, status_code: "EMPLOYED" },
      })
    ).app_user_id;
    breakdownId = (
      await prisma.breakdown.create({
        data: {
          breakdown_no: PREFIX,
          equipment_id: equipmentId,
          reported_at: new Date("2026-09-01T01:00:00Z"),
          status_code: "RECEIVED",
          description: "물리 FK 검증용 고장",
        },
      })
    ).breakdown_id;
  });

  afterAll(async () => {
    try {
      await cleanup();
      const remaining = await Promise.all([
        prisma.equipment_downtime.count({
          where: {
            OR: [
              { equipment_id: equipmentId ?? -1n },
              { equipment: { equipment_code: PREFIX } },
            ],
          },
        }),
        prisma.breakdown.count({ where: { breakdown_no: PREFIX } }),
        prisma.equipment.count({ where: { equipment_code: PREFIX } }),
        prisma.app_user.count({ where: { login_id: PREFIX } }),
        prisma.plant.count({ where: { plant_code: PREFIX } }),
        prisma.business_unit.count({ where: { business_unit_code: PREFIX } }),
        prisma.legal_entity.count({ where: { legal_entity_code: PREFIX } }),
      ]);
      expect(remaining).toEqual([0, 0, 0, 0, 0, 0, 0]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it("S01 새 nullable 두 칸·version과 완화 type의 타입·길이·default가 정본과 같다", async () => {
    const columns = await prisma.$queryRaw<Column[]>`
      SELECT column_name,data_type,is_nullable,column_default,
             character_maximum_length,datetime_precision,domain_name
      FROM information_schema.columns
      WHERE table_schema='maintenance' AND table_name='equipment_downtime'`;
    expect(columns).toHaveLength(13);
    const byName = Object.fromEntries(
      columns.map((column) => [column.column_name, column]),
    );
    expect(byName.remarks).toMatchObject({
      data_type: "text",
      is_nullable: "YES",
      column_default: null,
    });
    expect(byName.recorded_by_worker_no).toMatchObject({
      data_type: "character varying",
      character_maximum_length: 50,
      is_nullable: "YES",
      column_default: null,
      domain_name: null,
    });
    expect(byName.version_no).toMatchObject({
      data_type: "integer",
      is_nullable: "NO",
      column_default: "1",
    });
    expect(byName.downtime_type_code).toMatchObject({
      data_type: "character varying",
      character_maximum_length: 50,
      is_nullable: "YES",
      column_default: null,
      domain_name: "code_t",
    });
    for (const name of ["started_at", "ended_at", "created_at"]) {
      expect(byName[name]).toMatchObject({
        data_type: "timestamp with time zone",
        datetime_precision: 6,
      });
    }
    expect(byName.closed_by_worker_no).toBeUndefined();
    expect(byName.work_session_id).toBeUndefined();
  });

  it("S02 네 컬럼 주석이 최초 사번·메모·구 유형·버전의 의미를 보존한다", async () => {
    const comments = await prisma.$queryRaw<
      { name: string; description: string }[]
    >`
      SELECT a.attname AS name,col_description(a.attrelid,a.attnum) AS description
      FROM pg_attribute a
      WHERE a.attrelid='maintenance.equipment_downtime'::regclass
        AND a.attname IN ('recorded_by_worker_no','remarks','downtime_type_code','version_no')`;
    expect(
      Object.fromEntries(comments.map((row) => [row.name, row.description])),
    ).toEqual({
      recorded_by_worker_no:
        "비가동을 최초 기록한 귀속용 X-Worker-No 원문. 계정 created_by와 별개이며 과거행은 임의 백필하지 않는다.",
      remarks: "현장 비가동 메모. DowntimeCreate/Update.remarks.",
      downtime_type_code:
        "계약에 입력과 값 정의가 없는 기존 축. 신규 비가동은 null; reason_code를 복제하지 않는다.",
      version_no:
        "상세 GET ETag와 수정/종료 If-Match 토큰. 본문에 노출하지 않는다.",
    });
  });

  it("S03 구 writer 형상은 사유·최초 사번을 발명하지 않고 nullable와 version1을 남긴다 — 108", async () => {
    // 서버팀 결정·통보 108: 마이그 후 물리 저장 검증이며 required API 응답의 성공 근거가 아니다.
    const row = await snapshot(await insert());
    expect(row).toMatchObject({
      equipment_id: equipmentId,
      downtime_type_code: null,
      reason_code: null,
      recorded_by_worker_no: null,
      remarks: null,
      version_no: 1,
      breakdown_id: null,
      created_by: actorId,
      closed_by: actorId,
      started_epoch_us: STARTED_EPOCH_US,
      ended_epoch_us: null,
    });
    const legacy = await insert();
    await prisma.equipment_downtime.update({
      where: { equipment_downtime_id: legacy },
      data: { downtime_type_code: "LEGACY", reason_code: "구 사유 원문" },
    });
    expect(await snapshot(legacy)).toMatchObject({
      downtime_type_code: "LEGACY",
      reason_code: "구 사유 원문",
      recorded_by_worker_no: null,
      version_no: 1,
    });
  });

  it("S04 최초 사번50자·메모 원문 왕복과 null 해제가 계정 감사값과 µs를 바꾸지 않는다 — 108", async () => {
    // 서버팀 결정·통보 108: 귀속 원문을 계정 숫자로 도출하거나 덮지 않는다.
    const id = await insert();
    const original = await snapshot(id);
    const workerNo = "W".repeat(50);
    const remarks = "현장 원문\n유압 호스 교체 대기 — 변경 없이";
    await prisma.equipment_downtime.update({
      where: { equipment_downtime_id: id },
      data: { recorded_by_worker_no: workerNo, remarks },
    });
    expect(await snapshot(id)).toEqual({
      ...original,
      recorded_by_worker_no: workerNo,
      remarks,
    });
    await prisma.equipment_downtime.update({
      where: { equipment_downtime_id: id },
      data: { recorded_by_worker_no: null, remarks: null },
    });
    expect(await snapshot(id)).toEqual(original);
  });

  it("S05 최초 사번51자는 물리 길이 제약으로 거부된다", async () => {
    const id = await insert();
    const original = await snapshot(id);
    await expect(prisma.$executeRaw`
      UPDATE maintenance.equipment_downtime SET recorded_by_worker_no=${"W".repeat(51)}
      WHERE equipment_downtime_id=${id}`).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "22001" },
    });
    expect(await snapshot(id)).toEqual(original);
  });

  it("S06 version 기본1과 양수 변경은 허용하고0·음수·null은 각각 거부된다", async () => {
    const id = await insert();
    expect((await snapshot(id)).version_no).toBe(1);
    await prisma.equipment_downtime.update({
      where: { equipment_downtime_id: id },
      data: { version_no: 7 },
    });
    const original = await snapshot(id);
    expect(original.version_no).toBe(7);
    for (const version of [0, -1]) {
      await expect(prisma.$executeRaw`
        UPDATE maintenance.equipment_downtime SET version_no=${version}
        WHERE equipment_downtime_id=${id}`).rejects.toMatchObject({
        code: "P2010",
        meta: { code: "23514" },
      });
      expect(await snapshot(id)).toEqual(original);
    }
    await expect(prisma.$executeRaw`
      UPDATE maintenance.equipment_downtime SET version_no=NULL
      WHERE equipment_downtime_id=${id}`).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23502" },
    });
    expect(await snapshot(id)).toEqual(original);
    const checks = await prisma.$queryRaw<
      { name: string; definition: string }[]
    >`
      SELECT conname AS name,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid='maintenance.equipment_downtime'::regclass
        AND contype='c' ORDER BY conname`;
    expect(checks).toEqual([
      {
        name: "ck_equipment_downtime_window",
        definition: "CHECK (((ended_at IS NULL) OR (ended_at >= started_at)))",
      },
      {
        name: "equipment_downtime_version_no_check",
        definition: "CHECK ((version_no > 0))",
      },
    ]);
  });

  it("S07 기존 시간CHECK는 열린·0길이를 허용하고 역전 종료만 거부한다", async () => {
    const id = await insert();
    expect((await snapshot(id)).ended_epoch_us).toBeNull();
    await prisma.$executeRaw`
      UPDATE maintenance.equipment_downtime SET ended_at=${STARTED_AT}::timestamptz
      WHERE equipment_downtime_id=${id}`;
    const zero = await snapshot(id);
    expect(zero.ended_epoch_us).toBe(STARTED_EPOCH_US);
    await expect(prisma.$executeRaw`
      UPDATE maintenance.equipment_downtime SET ended_at=${"2026-09-01T01:02:03.123455Z"}::timestamptz
      WHERE equipment_downtime_id=${id}`).rejects.toMatchObject({
      code: "P2010",
      meta: { code: "23514" },
    });
    expect(await snapshot(id)).toEqual(zero);
  });

  it("S08 동일 설비의 중복open과 닫힌 겹침은 물리적으로 허용된다 — 110", async () => {
    // 서버팀 결정·통보 110: 물리 비유일 보존이며 신규 API의 설비 잠금 정책과 별개다.
    const ids = [
      await insert(),
      await insert(),
      await insert(),
      await insert(),
    ];
    await prisma.$executeRaw`
      UPDATE maintenance.equipment_downtime SET ended_at=${"2026-09-01T01:03:03.123456Z"}::timestamptz
      WHERE equipment_downtime_id IN (${ids[2]},${ids[3]})`;
    const rows = await Promise.all(ids.map(snapshot));
    expect(rows.filter((row) => row.ended_epoch_us === null)).toHaveLength(2);
    expect(
      rows.filter((row) => row.ended_epoch_us === "1788224583123456"),
    ).toHaveLength(2);
    const indexes = await prisma.$queryRaw<
      { indexname: string; indexdef: string }[]
    >`
      SELECT indexname,indexdef FROM pg_indexes
      WHERE schemaname='maintenance' AND tablename='equipment_downtime' ORDER BY indexname`;
    expect(indexes).toEqual([
      {
        indexname: "equipment_downtime_pkey",
        indexdef:
          "CREATE UNIQUE INDEX equipment_downtime_pkey ON maintenance.equipment_downtime USING btree (equipment_downtime_id)",
      },
      {
        indexname: "ix_equipment_downtime_open",
        indexdef:
          "CREATE INDEX ix_equipment_downtime_open ON maintenance.equipment_downtime USING btree (equipment_id, started_at DESC) WHERE (ended_at IS NULL)",
      },
    ]);
    const extra = await prisma.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_constraint
      WHERE conrelid='maintenance.equipment_downtime'::regclass AND contype IN ('u','x')`;
    expect(extra[0].count).toBe(0n);
  });

  it("S09 기존 설비·고장·종료계정 FK 세 개의 참조와 NO ACTION을 보존한다", async () => {
    const id = await insert();
    await prisma.equipment_downtime.update({
      where: { equipment_downtime_id: id },
      data: { breakdown_id: breakdownId },
    });
    const constraints = await prisma.$queryRaw<
      {
        name: string;
        definition: string;
        on_delete: string;
        on_update: string;
      }[]
    >`
      SELECT conname AS name,pg_get_constraintdef(oid) AS definition,
             confdeltype::text AS on_delete,confupdtype::text AS on_update
      FROM pg_constraint WHERE conrelid='maintenance.equipment_downtime'::regclass
        AND contype='f' ORDER BY conname`;
    expect(constraints).toEqual([
      {
        name: "equipment_downtime_breakdown_id_fkey",
        definition:
          "FOREIGN KEY (breakdown_id) REFERENCES maintenance.breakdown(breakdown_id)",
        on_delete: "a",
        on_update: "a",
      },
      {
        name: "equipment_downtime_closed_by_fkey",
        definition:
          "FOREIGN KEY (closed_by) REFERENCES app.app_user(app_user_id)",
        on_delete: "a",
        on_update: "a",
      },
      {
        name: "equipment_downtime_equipment_id_fkey",
        definition:
          "FOREIGN KEY (equipment_id) REFERENCES mdm.equipment(equipment_id)",
        on_delete: "a",
        on_update: "a",
      },
    ]);
    for (const data of [
      { equipment_id: -1n },
      { breakdown_id: -1n },
      { closed_by: -1n },
    ]) {
      await expect(
        prisma.equipment_downtime.update({
          where: { equipment_downtime_id: id },
          data,
        }),
      ).rejects.toMatchObject({ code: "P2003" });
    }
    await expect(
      prisma.breakdown.delete({ where: { breakdown_id: breakdownId } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.app_user.delete({ where: { app_user_id: actorId } }),
    ).rejects.toMatchObject({ code: "P2003" });
    await expect(
      prisma.equipment.delete({ where: { equipment_id: equipmentId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("S10 새 최초 사번은 worker FK나 계정 변환 없이 별도 원문으로 저장된다 — 108", async () => {
    // 서버팀 결정·통보 108: API의 사번 검증 책임을 물리 FK나 기본값으로 대체하지 않는다.
    const workerNo = `${PREFIX}-UNLINKED`;
    expect(await prisma.worker.count({ where: { worker_no: workerNo } })).toBe(
      0,
    );
    const id = await insert();
    await prisma.equipment_downtime.update({
      where: { equipment_downtime_id: id },
      data: { recorded_by_worker_no: workerNo },
    });
    expect(await snapshot(id)).toMatchObject({
      recorded_by_worker_no: workerNo,
      created_by: actorId,
      closed_by: actorId,
    });
    expect(await prisma.worker.count({ where: { worker_no: workerNo } })).toBe(
      0,
    );
  });

  async function insert(): Promise<bigint> {
    const rows = await prisma.$queryRaw<{ equipment_downtime_id: bigint }[]>`
      INSERT INTO maintenance.equipment_downtime (equipment_id,started_at,created_by,closed_by)
      VALUES (${equipmentId},${STARTED_AT}::timestamptz,${actorId},${actorId})
      RETURNING equipment_downtime_id`;
    return rows[0].equipment_downtime_id;
  }

  async function snapshot(id: bigint): Promise<DowntimeSnapshot> {
    const rows = await prisma.$queryRaw<DowntimeSnapshot[]>`
      SELECT equipment_downtime_id,equipment_id,breakdown_id,downtime_type_code,
             reason_code,closed_by,created_by,remarks,recorded_by_worker_no,version_no,
             ((extract(epoch FROM started_at)*1000000)::bigint)::text AS started_epoch_us,
             ((extract(epoch FROM ended_at)*1000000)::bigint)::text AS ended_epoch_us,
             ((extract(epoch FROM created_at)*1000000)::bigint)::text AS created_epoch_us
      FROM maintenance.equipment_downtime WHERE equipment_downtime_id=${id}`;
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  async function cleanup(): Promise<void> {
    await prisma.equipment_downtime.deleteMany({
      where: { equipment: { equipment_code: PREFIX } },
    });
    await prisma.breakdown.deleteMany({ where: { breakdown_no: PREFIX } });
    await prisma.equipment.deleteMany({ where: { equipment_code: PREFIX } });
    await prisma.app_user.deleteMany({ where: { login_id: PREFIX } });
    await prisma.plant.deleteMany({ where: { plant_code: PREFIX } });
    await prisma.business_unit.deleteMany({
      where: { business_unit_code: PREFIX },
    });
    await prisma.legal_entity.deleteMany({
      where: { legal_entity_code: PREFIX },
    });
  }
});
