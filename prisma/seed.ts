import { randomBytes, scrypt } from 'node:crypto';

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 기준정보 공통코드 시드.
 *
 * baseline 마이그레이션(정본 물리 모델)이 이미 OPERATION_POLICY·INVENTORY_STATUS를
 * 넣어 두므로, 여기서는 업무 도메인 코드만 추가한다.
 * 코드 체계 근거: research/2026-07-03-개념데이터모델-v2-요구사항통합.md §1
 */
interface CodeValueSeed {
  code: string;
  codeName: string;
  order: number;
}

interface CodeGroupSeed {
  groupCode: string;
  groupName: string;
  values: CodeValueSeed[];
  /** 참이면 값에 서버 동작·화면 분기가 걸려 고객이 값을 더하거나 지울 수 없다(공유계약 G-31 · 이슈 #62). */
  isSystemOwned?: boolean;
  /**
   * 이 그룹에서 물러난 코드. 지우지 않고 is_active=false로 내린다 — 코드값을 가리키는
   * FK가 물리에 0건이라 행을 지우면 그 문자열을 담고 있던 업무 행이 조용히 갈 곳을 잃는다.
   */
  retired?: string[];
}

const SEED: CodeGroupSeed[] = [
  {
    // 코드 사전 CD-ITEM-TYPE. 옛 RAW/SEMI/FG/MDSE 는 마이그레이션 20260904130000 이 제자리에서
    // 개명했고, 사전에 없는 DEV(개발품)는 내린다. ⛔ 예비품은 여기 넣지 않는다(QA #7).
    groupCode: 'ITEM_TYPE',
    groupName: '품목구분',
    values: [
      { code: 'RAW_MATERIAL', codeName: '원자재', order: 10 },
      { code: 'SEMI_FINISHED', codeName: '반제품', order: 20 },
      { code: 'FINISHED', codeName: '제품', order: 30 },
      { code: 'MERCHANDISE', codeName: '상품', order: 40 },
    ],
    retired: ['DEV'],
  },
  {
    groupCode: 'INSPECTION_TYPE',
    groupName: '검사유형',
    values: [
      { code: 'IQC', codeName: '수입검사', order: 10 },
      { code: 'PQC', codeName: '공정검사', order: 20 },
      { code: 'OQC', codeName: '출하검사', order: 30 },
    ],
  },
  {
    // DDL 주석이 값을 명시한다: line_type_code = LINE | WORK_AREA
    groupCode: 'LINE_TYPE',
    groupName: '라인 유형',
    values: [
      { code: 'LINE', codeName: '라인', order: 10 },
      { code: 'WORK_AREA', codeName: '작업구역', order: 20 },
    ],
  },
  {
    // 기술스택 결정 16의 폼팩터. ⛔ 관리웹은 단말 마스터에 등록하지 않는다 — 현장 단말만 든다
    // (계약 Terminal.terminalTypeCode). 시스템 소유 — 폼팩터는 아키텍처 축이라 고객이 늘리지 않는다.
    groupCode: 'TERMINAL_TYPE',
    groupName: '단말 유형',
    isSystemOwned: true,
    values: [
      { code: 'POP', codeName: 'POP 단말', order: 10 },
      { code: 'MOBILE', codeName: '모바일 스캐너', order: 20 },
    ],
    retired: ['ADMIN_WEB'],
  },
  {
    // 가동 상태. ⛔ is_active(켬/끔)와 다른 축이고 폐기는 재발급이 담당한다(W-CO-06 §5-4) —
    // 그래서 점검중·폐기 값이 없다. 옛 NORMAL 은 마이그레이션 20260904130000 이 RUNNING 으로 개명했다.
    groupCode: 'TERMINAL_STATUS',
    groupName: '단말 상태',
    isSystemOwned: true,
    values: [
      { code: 'RUNNING', codeName: '가동', order: 10 },
      { code: 'STOPPED', codeName: '정지', order: 20 },
    ],
    retired: ['MAINTENANCE', 'DISPOSED'],
  },
  {
    // ⛔ 이름도 뜻도 갈렸다. 예전 USER_STATUS 는 「계정 상태」였는데, 계정을 쓸 수 있는가는
    // app_user.is_active 가 정하는 것으로 축이 갈렸다(계약 AppUser.statusCode · 설계 확정
    // 2026-09-01 · W-CO-02 §8-4). 남은 축은 «인사» 상태이고, 계약이 그 값 목록을
    // codeGroupCode=APP_USER_STATUS 로 부른다. 재직에 ACTIVE 를 쓰지 않는다 — 사용 여부와
    // 같은 낱말이면 두 축이 다시 섞인다(CD-APP-USER-STATUS · 마이그레이션 20260904120000).
    groupCode: 'APP_USER_STATUS',
    groupName: '사용자 인사 상태',
    values: [
      { code: 'EMPLOYED', codeName: '재직', order: 10 },
      { code: 'ON_LEAVE', codeName: '휴직', order: 20 },
      { code: 'RESIGNED', codeName: '퇴사', order: 30 },
    ],
  },
  {
    groupCode: 'WORKER_STATUS',
    groupName: '재직 상태',
    values: [
      { code: 'ACTIVE', codeName: '재직', order: 10 },
      { code: 'LEAVE', codeName: '휴직', order: 20 },
      { code: 'RESIGNED', codeName: '퇴직', order: 30 },
    ],
  },
  {
    // 기존 2값이 설계 4값에 그대로 들어 있다. 순수 추가라 내릴 값이 없다.
    groupCode: 'QUALIFICATION_TYPE',
    groupName: '작업자 자격 유형',
    values: [
      { code: 'PROCESS_OPERATION', codeName: '공정수행자격', order: 10 },
      { code: 'INSPECTOR', codeName: '검사자자격', order: 20 },
      { code: 'SAFETY', codeName: '안전자격', order: 30 },
      { code: 'EQUIPMENT_OPERATION', codeName: '설비운전자격', order: 40 },
    ],
  },
  {
    // 개념모델 v2 §1 툴/금형의 '신규입고/폐기 상태'를 축으로 삼았다.
    groupCode: 'MOLD_STATUS',
    groupName: '금형 상태',
    values: [
      { code: 'NEW', codeName: '신규입고', order: 10 },
      { code: 'NORMAL', codeName: '정상', order: 20 },
      { code: 'REPAIR', codeName: '수리중', order: 30 },
      { code: 'DISPOSED', codeName: '폐기', order: 40 },
    ],
  },
  {
    // 계측기 계열이 INSTRUMENT_TYPE 으로 분리되면서 이 그룹은 설비 계열만 남는다.
    // 우리 3값(MACHINE·INSPECTION·UTILITY)은 두 계열이 섞여 있던 것이라 전부 내린다.
    // INSPECTION 계열은 새로 세운 INSTRUMENT_TYPE 이 받는다.
    groupCode: 'EQUIPMENT_TYPE',
    groupName: '설비 유형',
    values: [
      { code: 'INJECTION_MOLDING', codeName: '사출기', order: 10 },
      { code: 'PRESS', codeName: '프레스', order: 20 },
      { code: 'WATER_HEATER', codeName: '온수기', order: 30 },
    ],
    retired: ['MACHINE', 'INSPECTION', 'UTILITY'],
  },
  {
    // 다섯을 둘로 줄인다. 설계가 이 컬럼을 «자산 수명주기» 축으로 확정했다 —
    // 운용 중인가 폐기됐는가 둘뿐이고, 점검중·고장은 상태가 아니라 사건이다
    // (maintenance.equipment_inspection · breakdown 이 담는다). 05-재검토 조치 13번.
    groupCode: 'EQUIPMENT_STATUS',
    groupName: '설비 자산 수명주기',
    values: [
      { code: 'IN_SERVICE', codeName: '운용', order: 10 },
      { code: 'DISPOSED', codeName: '폐기', order: 20 },
    ],
    retired: ['NEW', 'NORMAL', 'MAINTENANCE', 'BREAKDOWN'],
  },
  {
    // 축이 다르다. 우리 2값(INTERNAL·OUTSOURCED)은 외주 여부인데, 그 축은
    // planning.routing_operation.is_subcontract 가 따로 갖고 있다(실측 확인). 이 컬럼은
    // 공정을 «어떤 종류의 작업인지»로 분류하는 자리다 — 설계 4값이 그것이다.
    groupCode: 'PROCESS_TYPE',
    groupName: '공정 유형',
    values: [
      { code: 'MACHINING', codeName: '가공', order: 10 },
      { code: 'ASSEMBLY', codeName: '조립', order: 20 },
      { code: 'INSPECTION', codeName: '검사', order: 30 },
      { code: 'PACKAGING', codeName: '포장', order: 40 },
    ],
    retired: ['INTERNAL', 'OUTSOURCED'],
  },
  {
    groupCode: 'PARTNER_ROLE_TYPE',
    groupName: '거래처 역할',
    values: [
      { code: 'SUPPLIER', codeName: '공급사', order: 10 },
      { code: 'CUSTOMER', codeName: '고객', order: 20 },
      { code: 'SUBCONTRACTOR', codeName: '외주처', order: 30 },
      { code: 'CARRIER', codeName: '운송업체', order: 40 },
    ],
  },
  {
    groupCode: 'LOT_CONTROL_TYPE',
    groupName: 'LOT 관리방식',
    values: [
      { code: 'NONE', codeName: 'LOT 미관리', order: 10 },
      { code: 'LOT', codeName: 'LOT 관리', order: 20 },
    ],
  },
  {
    groupCode: 'SERIAL_CONTROL_TYPE',
    groupName: '일련번호 관리방식',
    values: [
      { code: 'NONE', codeName: '미관리', order: 10 },
      { code: 'SERIAL', codeName: '개별 일련번호 관리', order: 20 },
    ],
  },
  {
    groupCode: 'FIFO_POLICY',
    groupName: '선출 정책',
    values: [
      { code: 'FIFO', codeName: '선입선출', order: 10 },
      { code: 'FEFO', codeName: '유효기간 임박 우선', order: 20 },
    ],
  },
  {
    groupCode: 'MANAGEMENT_LEVEL',
    groupName: '창고 관리수준',
    values: [
      { code: 'WAREHOUSE', codeName: '창고', order: 10 },
      { code: 'ZONE', codeName: '구역', order: 20 },
      { code: 'RACK', codeName: '랙', order: 30 },
      { code: 'CELL', codeName: '셀', order: 40 },
    ],
  },
  {
    // 위치의 «물리적 형태» 한 축 — 계층 깊이는 MANAGEMENT_LEVEL 이 따로 갖는다(CD-LOCATION-TYPE).
    // TEMP(M-01-07 임시) · HOPPER(M-01-09) · DEFAULT(M-01-04 흡수용)는 화면이 판정에 쓰는 값이다.
    // 옛 ZONE/CELL/DOCK 은 사전에 대응값이 없어 내린다 — 기존 위치 행은 그대로 둔다.
    groupCode: 'LOCATION_TYPE',
    groupName: '로케이션 유형',
    values: [
      { code: 'RACK', codeName: '랙', order: 10 },
      { code: 'FLOOR', codeName: '평치', order: 20 },
      { code: 'TEMP', codeName: '임시', order: 30 },
      { code: 'HOPPER', codeName: '호퍼', order: 40 },
      { code: 'DEFAULT', codeName: '기본', order: 50 },
    ],
    retired: ['ZONE', 'CELL', 'DOCK'],
  },
  {
    groupCode: 'QUALITY_ZONE',
    groupName: '품질구역',
    values: [
      { code: 'AVAILABLE', codeName: '가용', order: 10 },
      { code: 'INSPECTION', codeName: '검사대기', order: 20 },
      { code: 'HOLD', codeName: '보류', order: 30 },
      { code: 'QUARANTINE', codeName: '격리', order: 40 },
    ],
  },
  {
    // 뜻은 겹치나 코드 문자열이 다르다 — NORMAL→ROOM_TEMPERATURE ·
    // COLD→REFRIGERATED · HAZARD→HAZARDOUS. 설계 표기를 따르고 옛 코드는 내린다.
    // MOISTURE_CONTROLLED 가 늘었다.
    groupCode: 'STORAGE_CONDITION',
    groupName: '보관 조건',
    values: [
      { code: 'REFRIGERATED', codeName: '냉장', order: 10 },
      { code: 'FROZEN', codeName: '냉동', order: 20 },
      { code: 'ROOM_TEMPERATURE', codeName: '상온', order: 30 },
      { code: 'MOISTURE_CONTROLLED', codeName: '방습', order: 40 },
      { code: 'HAZARDOUS', codeName: '위험물', order: 50 },
    ],
    retired: ['NORMAL', 'COLD', 'HAZARD'],
  },
  {
    /**
     * mdm.warehouse.warehouse_type_code — 2026-09-01 설계 회신이 6종으로 확정했다.
     *
     * DEFECT는 유형이 아니라 축이라 mdm.warehouse.is_defect(#47)로 옮겼다. 자재 불량창고와
     * 제품 불량창고가 모두 성립하는데 유형 칸이 하나뿐이라 유형에 두면 둘 중 하나를 버려야
     * 한다(DR-012 3-C). 유형에도 남기면 같은 뜻이 두 곳에 표현돼 축 섞임이 재발한다.
     *
     * REWORK는 설계 전체에서 '작업지시 유형' 값이고 재작업 *창고*라는 개념이 화면·계약·
     * 결정서 어디에도 없다. is_defect로 옮기면 폐기요청 화면(W-01-06)의 불량창고 선택이
     * 오염된다 — 그래서 옮기지 않고 내린다.
     *
     * SPARE_PART는 신설이다. goods_issue.source_warehouse_id가 NOT NULL로 mdm.warehouse를
     * 가리키므로 예비품 창고도 창고 마스터의 한 행이다 — mdm.spare_part는 *부품 품목*
     * 마스터이지 창고가 아니다(보전 화면 §3-3).
     *
     * 2026-09-03 코드 사전(CD-WAREHOUSE-TYPE)이 MATERIAL·PRODUCT·SPARE_PART·GENERAL 넷으로
     * 닫았다. 잠정으로 쓰던 SEMI_FINISHED·MERCHANDISE·PRODUCTION 은 대응값이 없어 내린다 —
     * 등록부라 고객이 필요하면 W-06-06 에서 다시 세운다. 기존 창고 행의 문자열은 그대로 둔다.
     */
    groupCode: 'WAREHOUSE_TYPE',
    groupName: '창고유형',
    values: [
      { code: 'MATERIAL', codeName: '자재창고', order: 10 },
      { code: 'PRODUCT', codeName: '제품창고', order: 20 },
      { code: 'SPARE_PART', codeName: '예비품창고', order: 30 },
      { code: 'GENERAL', codeName: '일반창고', order: 40 },
    ],
    retired: ['SEMI', 'MDSE', 'DEFECT', 'REWORK', 'SEMI_FINISHED', 'MERCHANDISE', 'PRODUCTION'],
  },
  {
    // BOM·Routing·검사기준은 개정(Rev) 단위로 살아 있다 — 상태축이 곧 개정 수명주기다.
    // ⛔ 시스템 소유 — 편집 가부가 이 값에 걸려 있어 고객이 지우면 잠금이 조용히 안 걸린다
    // (계약 Routing.statusCode). 옛 이름 REVISION_STATUS·값 ACTIVE 는 마이그레이션
    // 20260904110000 이 제자리에서 개명했다.
    groupCode: 'MASTER_VERSION_STATUS',
    groupName: '마스터 버전 상태',
    isSystemOwned: true,
    values: [
      { code: 'DRAFT', codeName: '작성중', order: 10 },
      { code: 'CONFIRMED', codeName: '확정', order: 20 },
      { code: 'OBSOLETE', codeName: '폐기', order: 30 },
    ],
  },
  {
    // v2에서 required_completion_rate를 뺐으므로 선후행 관계는 유형만 남는다.
    groupCode: 'DEPENDENCY_TYPE',
    groupName: '공정 선후행 유형',
    values: [
      { code: 'FINISH_TO_START', codeName: '선행 완료 후 착수', order: 10 },
      { code: 'START_TO_START', codeName: '동시 착수', order: 20 },
      { code: 'FINISH_TO_FINISH', codeName: '동시 완료', order: 30 },
    ],
  },
  {
    groupCode: 'SAMPLING_METHOD',
    groupName: '샘플링 방식',
    values: [
      { code: 'FULL', codeName: '전수검사', order: 10 },
      { code: 'FIXED', codeName: '고정 수량 샘플링', order: 20 },
      { code: 'AQL', codeName: 'AQL 샘플링', order: 30 },
    ],
  },
  {
    // 축이 통째로 바뀐다. 우리 4값(EVERY_LOT·FIRST_MIDDLE_LAST·SELF·PERIODIC)은
    // 「얼마나 자주」였는데 설계 8값은 「무엇이 검사를 촉발하나」다. 같은 컬럼에 다른 축을
    // 담고 있었다. 우리 값은 하나도 살아남지 않는다.
    groupCode: 'INSPECTION_FREQUENCY',
    groupName: '검사 주기',
    values: [
      { code: 'WORK_ORDER', codeName: '매 작업지시', order: 10 },
      { code: 'PRODUCTION_LOT', codeName: '매 생산 LOT', order: 20 },
      { code: 'MATERIAL_LOT', codeName: '매 자재 LOT', order: 30 },
      { code: 'SHIFT', codeName: '근무조별', order: 40 },
      { code: 'TIME_INTERVAL', codeName: '일정 시간별', order: 50 },
      { code: 'QUANTITY_INTERVAL', codeName: '일정 생산수량별', order: 60 },
      { code: 'EQUIPMENT_MOLD_CHANGE', codeName: '설비·금형 변경 시', order: 70 },
      { code: 'USER_REQUEST', codeName: '사용자 요청 시', order: 80 },
    ],
    retired: ['EVERY_LOT', 'FIRST_MIDDLE_LAST', 'SELF', 'PERIODIC'],
  },
  {
    // inspection_plan_version.frequency_interval_value의 단위 — 주기가 PERIODIC일 때만 쓴다.
    groupCode: 'FREQUENCY_INTERVAL_UOM',
    groupName: '검사주기 단위',
    values: [
      { code: 'HOUR', codeName: '시간', order: 10 },
      { code: 'MINUTE', codeName: '분', order: 20 },
      { code: 'QTY', codeName: '수량', order: 30 },
      { code: 'SHIFT', codeName: '교대', order: 40 },
    ],
  },
  {
    groupCode: 'INSPECTION_DATA_TYPE',
    groupName: '검사항목 데이터유형',
    values: [
      { code: 'NUMERIC', codeName: '계량형(수치)', order: 10 },
      { code: 'BOOLEAN', codeName: '계수형(합·부)', order: 20 },
      { code: 'TEXT', codeName: '서술형', order: 30 },
    ],
  },
  {
    groupCode: 'INSPECTION_METHOD',
    groupName: '검사 방법',
    values: [
      { code: 'VISUAL', codeName: '육안검사', order: 10 },
      { code: 'MEASURE', codeName: '계측', order: 20 },
      { code: 'GAUGE', codeName: '게이지', order: 30 },
      { code: 'FUNCTION', codeName: '기능검사', order: 40 },
    ],
  },
  {
    // numbering_rule.document_type_code — 채번 대상 문서. 물리 모델의 *_no 컬럼 보유
    // 트랜잭션과 LOT이 대상이다(예: 'WO-{PLANT}-{YYMMDD}-{SEQ4}').
    groupCode: 'DOCUMENT_TYPE',
    groupName: '채번 문서유형',
    values: [
      { code: 'LOT', codeName: 'LOT 번호', order: 10 },
      { code: 'WORK_ORDER', codeName: '작업지시', order: 20 },
      { code: 'PRODUCTION_RESULT', codeName: '생산실적', order: 30 },
      { code: 'INSPECTION_REQUEST', codeName: '검사요청', order: 40 },
      { code: 'INSPECTION_RESULT', codeName: '검사결과', order: 50 },
      { code: 'GOODS_RECEIPT', codeName: '입고', order: 60 },
      { code: 'GOODS_ISSUE', codeName: '출고', order: 70 },
      { code: 'SHIPMENT', codeName: '출하', order: 80 },
      { code: 'STOCK_TRANSFER', codeName: '재고이동', order: 90 },
      { code: 'NONCONFORMANCE', codeName: '부적합', order: 100 },
    ],
  },
  {
    // 채번 시퀀스를 언제 1로 되돌리나. numbering_counter.period_key의 산출 단위가 된다.
    groupCode: 'RESET_CYCLE',
    groupName: '채번 리셋주기',
    values: [
      { code: 'NONE', codeName: '리셋 없음(연속)', order: 10 },
      { code: 'DAILY', codeName: '일 단위', order: 20 },
      { code: 'MONTHLY', codeName: '월 단위', order: 30 },
      { code: 'YEARLY', codeName: '연 단위', order: 40 },
    ],
  },
  {
    groupCode: 'APPROVAL_TYPE',
    groupName: '결재 유형',
    values: [
      { code: 'CONCESSION', codeName: '특채(수리 없이 사용)', order: 10 },
      { code: 'DISPOSITION', codeName: '부적합 처리 판정', order: 20 },
      { code: 'MATERIAL_SUBSTITUTION', codeName: '대체자재 사용', order: 30 },
      { code: 'INVENTORY_ADJUSTMENT', codeName: '재고 조정', order: 40 },
      { code: 'LATE_ENTRY', codeName: '마감 후 정정', order: 50 },
    ],
  },
  {
    // approval_route_step.approver_type_code — DDL 주석이 값을 명시한다: USER | ROLE | DEPARTMENT
    groupCode: 'APPROVER_TYPE',
    groupName: '승인자 지정 방식',
    values: [
      { code: 'USER', codeName: '지정 사용자', order: 10 },
      { code: 'ROLE', codeName: '역할', order: 20 },
      { code: 'DEPARTMENT', codeName: '부서', order: 30 },
    ],
  },
  {
    // OPERATION_POLICY 14종은 baseline 마이그레이션이 시드한다. 여기서는 그 뒤에 생긴
    // 정책코드만 더한다(값 upsert라 기존 14종은 건드리지 않는다).
    //
    // 자격 검증을 처음부터 강제하면 worker_qualification이 비어 있어 전원이 무자격이 되고
    // 현장이 선다. 점검 통제(QA #9)와 같은 3단계 설정형으로 두고 기본은 끈다.
    groupCode: 'OPERATION_POLICY',
    groupName: '운영정책 코드',
    values: [
      {
        code: 'WORKER_QUALIFICATION_ENFORCEMENT',
        codeName: '작업자 자격 검증 수준(BLOCK|WARN|OFF)',
        order: 150,
      },
    ],
  },
  {
    groupCode: 'CALIBRATION_RESULT',
    groupName: '검교정 결과',
    values: [
      { code: 'PASS', codeName: '적합', order: 10 },
      { code: 'ADJUSTED', codeName: '조정 후 적합', order: 20 },
      { code: 'FAIL', codeName: '부적합', order: 30 },
    ],
  },
  {
    /**
     * work_order.status_code — 2026-09-01 설계 회신 확정 9값.
     *
     * ⚠ 이 그룹은 우리가 근거 없이 값을 만들어 뒀던 자리다. 계약 7벌에 그룹명도 값 enum도
     * 0건인데 7값이 들어가 있었고, 설계팀이 '확정된 적 없으니 임의로 만들지 말라'고 통지한
     * 뒤에야 드러났다. 아래가 확정본이며 우리 7값을 대체한다.
     *
     * 바뀐 것은 셋이다 — HOLD를 SUSPENDED로 갈고 CONFIRMED·BLOCKED를 더한다. 설계 정본의
     * '8종' 표기가 BLOCKED를 떨어뜨린 것이 그동안 문서끼리 어긋난 원인이었고, 설계팀이
     * 아홉으로 정정하며 클라이언트팀에도 같은 값을 보냈다.
     *
     * ⛔ '확정 대기'는 저장하는 상태 값이 아니다. 화면 용어이고 실제 게이트는 '배포 시각
     * 없음 AND 계획 자원 배정 1건 이상 AND 4M 유효성 차단 0건'이라 서버가 질의로 판정한다.
     *
     * 낱말 여섯(PLANNED·RELEASED·IN_PROGRESS·COMPLETED·CANCELLED·BLOCKED)이 다른 그룹에도
     * 있다. code_value가 그룹 FK를 갖고 화면이 그룹을 지정해 받으므로 저장·조회가 갈린다 —
     * 설계 회신이 이 겹침을 알고 확정한 것이다.
     */
    groupCode: 'WORK_ORDER_STATUS',
    groupName: '작업지시 상태',
    isSystemOwned: true,
    values: [
      { code: 'PLANNED', codeName: '편성', order: 10 },
      { code: 'CONFIRMED', codeName: '확정', order: 20 },
      { code: 'RELEASED', codeName: '배포', order: 30 },
      { code: 'IN_PROGRESS', codeName: '진행', order: 40 },
      { code: 'SUSPENDED', codeName: '중단', order: 50 },
      { code: 'COMPLETED', codeName: '완료', order: 60 },
      { code: 'CLOSED', codeName: '마감', order: 70 },
      { code: 'CANCELLED', codeName: '취소', order: 80 },
    ],
    // ⛔ 진행불가(BLOCKED)는 상태가 아니라 확정 게이트다 — 사전이 8종으로 닫았다(CD-WORK-ORDER-STATUS).
    retired: ['HOLD', 'BLOCKED'],
  },
  {
    // work_session.status_code — 한 작업지시를 실제로 돌린 구간. A-25 전이표가 뜻을 정했다:
    // START·RESUME→RUNNING · STOP→STOPPED · END→ENDED. ⛔ 시스템 소유 — 전이 액션이 값을
    // 정하므로 고객이 늘리면 갈 곳 없는 값이 생긴다. 옛 OPEN/PAUSED/CLOSED 는 마이그레이션
    // 20260904130000 이 제자리에서 개명했다.
    groupCode: 'WORK_SESSION_STATUS',
    groupName: '작업세션 상태',
    isSystemOwned: true,
    values: [
      { code: 'RUNNING', codeName: '진행', order: 10 },
      { code: 'STOPPED', codeName: '중단', order: 20 },
      { code: 'ENDED', codeName: '종료', order: 30 },
    ],
  },
  {
    // PAUSE 를 STOP 으로 갈고 CONTROL_OVERRIDE 를 더한다. 계약이 STOP 을 쓴다 —
    // 「세션의 status_code 를 「중단」으로 옮기는 것은 events 의 eventTypeCode=STOP 이다」.
    // ⚠ 이 그룹은 시스템 소유다. 값에 따라 세션 상태·사유 필수 여부가 갈린다.
    groupCode: 'WORK_SESSION_EVENT_TYPE',
    groupName: '작업세션 사건 유형 ⛔ **시스템 소유 · 고객 편집 불가**',
    isSystemOwned: true,
    values: [
      { code: 'START', codeName: '시작', order: 10 },
      { code: 'STOP', codeName: '중단', order: 20 },
      { code: 'RESUME', codeName: '재개', order: 30 },
      { code: 'END', codeName: '종료', order: 40 },
      { code: 'CONTROL_OVERRIDE', codeName: '통제 우회', order: 50 },
    ],
    retired: ['PAUSE'],
  },
  {
    // production_result.result_source_code — 실적이 어디서 들어왔나.
    // 지금 쓰는 건 POP뿐이다. 설비 자동수집·관리 화면 수기는 자리만 잡아 둔다.
    groupCode: 'RESULT_SOURCE',
    groupName: '실적 입력 원천',
    values: [
      { code: 'POP', codeName: '현장 단말 입력', order: 10 },
      { code: 'EQUIPMENT', codeName: '설비 자동수집', order: 20 },
      { code: 'MANUAL', codeName: '관리 화면 수기', order: 30 },
    ],
  },
  {
    // production_result.status_code — 정정·취소(FR-PR-033/034/045)가 이 상태에서 갈린다.
    groupCode: 'PRODUCTION_RESULT_STATUS',
    groupName: '생산실적 상태',
    values: [
      { code: 'CONFIRMED', codeName: '확정', order: 10 },
      { code: 'CORRECTED', codeName: '정정됨', order: 20 },
      { code: 'CANCELLED', codeName: '취소', order: 30 },
    ],
  },

  // ── 2026-09-01 설계 개정 반영 (#62 · #63 회신) ──────────────────────────────
  // 아래 10그룹은 설계 회신이 값을 확정했거나, 저장 컬럼이 이미 있는데 시드가 비어
  // 있던 자리다. 저장 컬럼이 아직 없는 셋(SHIPMENT_TIME_SLOT·LOT_LIFECYCLE_STATUS·
  // LOT_STATUS_TRANSITION)은 후속 마이그레이션이 컬럼을 세운다 — 코드값은 컬럼과
  // 독립이라 먼저 넣어도 무해하고, 값이 한자리에 모여 있는 편이 대조하기 낫다.

  {
    // logistics.goods_issue.issue_type_code — 2026-08-31 사용자 확정.
    //
    // ⛔ 폐기는 출고 *유형*이 아니라 기타출고의 *사유*다. issue_type_code=OTHER로 두고
    //    reason_code로 가른다 — 승인 게이트도 유형이 아니라 사유를 보고 건다.
    groupCode: 'ISSUE_TYPE',
    groupName: '출고 유형',
    values: [
      { code: 'PRODUCTION', codeName: '생산투입', order: 10 },
      { code: 'SUPPLIER_RETURN', codeName: '공급사반품', order: 20 },
      { code: 'SHIPMENT', codeName: '출하', order: 30 },
      { code: 'OTHER', codeName: '기타출고', order: 40 },
    ],
  },
  {
    // logistics.goods_receipt.receipt_type_code — 2026-08-31 사용자 확정.
    groupCode: 'RECEIPT_TYPE',
    groupName: '입고 유형',
    values: [
      { code: 'MATERIAL', codeName: '자재입고', order: 10 },
      { code: 'PRODUCT', codeName: '제품입고', order: 20 },
      { code: 'RETURN', codeName: '반품입고', order: 30 },
      { code: 'TRANSFER', codeName: '창고간이동입고', order: 40 },
    ],
  },
  {
    // logistics.goods_receipt.reason_code — 고객이 운영 중에 설정하는 마스터다(G-31).
    // 아래는 개발 시드일 뿐 확정 목록이 아니다. 설계 회신이 한글 라벨만 확정했고 영문
    // 코드는 우리 명명에 맡겼다.
    groupCode: 'GOODS_RECEIPT_REASON',
    groupName: '입고 사유',
    values: [
      { code: 'CUSTOMER_RETURN', codeName: '고객반품', order: 10 },
      { code: 'CLAIM', codeName: '클레임', order: 20 },
      { code: 'SUPPLIER_REPLACEMENT', codeName: '공급사대체입고', order: 30 },
      { code: 'REWORK_RETURN', codeName: '재작업후재입고', order: 40 },
    ],
  },
  {
    // logistics.inbound_variance.variance_type_code
    //
    // ⚠ 수량 *초과*는 이 그룹을 쓰지 않는다 — inbound_receipt.exception_type_code에
    //   OVER_DELIVERY로 따로 간다(#62).
    groupCode: 'INBOUND_VARIANCE_TYPE',
    groupName: '입하 차이 유형',
    values: [
      { code: 'SHORTAGE', codeName: '수량 부족', order: 10 },
      { code: 'ITEM_MISMATCH', codeName: '품목 불일치', order: 20 },
      { code: 'UNREGISTERED_ITEM', codeName: '미등록 품목', order: 30 },
    ],
  },
  {
    // trace.lot_hold.release_reason_code
    groupCode: 'LOT_HOLD_RELEASE_REASON',
    groupName: 'LOT 보류 해제 사유',
    values: [
      { code: 'RETEST_PASS', codeName: '재검사 합격', order: 10 },
      { code: 'RETEST_FAIL', codeName: '재검사 불합격', order: 20 },
      { code: 'INVESTIGATION_CLEARED', codeName: '조사 종결', order: 30 },
      { code: 'MANAGER_OVERRIDE', codeName: '관리자 직권 해제', order: 40 },
    ],
  },
  {
    // logistics.material_issue_request.reason_code
    groupCode: 'MATERIAL_ISSUE_REQUEST_REASON',
    groupName: '자재 출고요청 사유',
    values: [
      { code: 'URGENT_WO_RESPONSE', codeName: '긴급 작업지시 대응', order: 10 },
      { code: 'SHORTAGE_SUPPLEMENT', codeName: '부족분 보충', order: 20 },
      { code: 'DEFECT_REPLACEMENT', codeName: '불량 대체', order: 30 },
      { code: 'OTHER', codeName: '기타', order: 40 },
    ],
  },
  {
    // 출하요청 시간대. 저장 컬럼은 후속 마이그레이션이 세우며, 기존
    // shipment_request.ship_time_slot_start/end 시각 범위를 이 코드가 대체한다.
    //
    // 시각 경계는 담지 않는다. 코드값은 슬롯을 가리키는 이름일 뿐이고 시각을 요구하는
    // 자리가 계약·화면 어디에도 없음을 설계팀이 전수 확인했다. 기존 CHECK가 end > start라
    // 야간 슬롯(자정 넘김)을 담지 못하던 결함도 이 전환으로 함께 사라진다.
    groupCode: 'SHIPMENT_TIME_SLOT',
    groupName: '출하 시간대',
    values: [
      { code: 'MORNING', codeName: '오전', order: 10 },
      { code: 'AFTERNOON', codeName: '오후', order: 20 },
      { code: 'NIGHT', codeName: '야간', order: 30 },
    ],
  },
  {
    // trace.lot.lifecycle_status_code — 저장 컬럼은 후속 마이그레이션이 세운다.
    //
    // ⛔ 품질 판정 축(trace.lot.status_code)과 *다른 축*이다. 한 이력에 섞지 않는다는 것이
    //    계약 명시 사항이고, 화면 스펙(W-03-01)에서 이 둘을 헷갈린 사고가 실제로 있었다.
    //    생산LOT 선발행에서만 쓰고 자재·제품 LOT은 null이다.
    //
    // ⚠ 그룹명 LOT_LIFECYCLE_STATUS는 우리가 지은 잠정 이름이다 — 공유계약 G-32 등록부에
    //   이 그룹이 없다. 값 셋은 2026-08-31 설계 회신(#50)이 확정한 것이다.
    groupCode: 'LOT_LIFECYCLE_STATUS',
    groupName: 'LOT 생명주기 상태',
    isSystemOwned: true,
    values: [
      { code: 'WAITING', codeName: '대기', order: 10 },
      { code: 'ACTIVE', codeName: '활성', order: 20 },
      { code: 'VOIDED', codeName: '폐번', order: 30 },
    ],
  },
  {
    // trace.lot_lifecycle_history.transition_code — 생명주기 축의 전이 셋.
    //
    // ⛔ 아래 LOT_STATUS_TRANSITION(품질 판정 축 C4~C15)과 «다른 축»이다. 계약이 두 축을
    //    한 이력에 섞지 말라고 못박았고 이력 표도 둘로 나뉜다 — 코드 그룹도 나눈다.
    //
    // ⚠ L3를 여는 것은 작업지시 취소 오퍼레이션 한 곳뿐이다. 사람이 화면에서 직접
    //   폐번하는 액션이 없어 이력 표에 '누가'를 담는 칸을 두지 않았다.
    //
    // ⚠ 그룹명 LOT_LIFECYCLE_TRANSITION은 우리가 지은 잠정 이름이다 — G-32 등록부에 없다.
    groupCode: 'LOT_LIFECYCLE_TRANSITION',
    groupName: 'LOT 생명주기 전이',
    isSystemOwned: true,
    values: [
      { code: 'L1', codeName: '대기 → 활성(첫 실적)', order: 10 },
      { code: 'L2', codeName: '대기 → 폐번(마감, 실적 없는 슬롯)', order: 20 },
      { code: 'L3', codeName: '활성 → 폐번(작업지시 취소)', order: 30 },
    ],
  },
  {
    // trace.lot_status_event.transition_code — 저장 컬럼은 후속 마이그레이션이 세운다.
    //
    // 품질 판정 축의 전이 정본 9종이다. 판정 유입 경계·데이터 배선·경계 위임은 상태
    // 전이가 아니라 제외했다고 설계팀이 밝혔다(2026-09-01 회신 E-9).
    //
    // ⚠ 그룹명 LOT_STATUS_TRANSITION은 우리가 지은 잠정 이름이다 — G-32 등록부에 없다.
    groupCode: 'LOT_STATUS_TRANSITION',
    groupName: 'LOT 상태 전이',
    isSystemOwned: true,
    values: [
      { code: 'C4', codeName: '판정 → Release(합격)', order: 10 },
      { code: 'C5', codeName: '판정 → 보류', order: 20 },
      { code: 'C6', codeName: '판정 → Hold(불합격)', order: 30 },
      { code: 'C7', codeName: '보류 → Release(재판정 합격)', order: 40 },
      { code: 'C8', codeName: '보류 → Hold(재판정 불합격)', order: 50 },
      { code: 'C9', codeName: 'Release → Hold(클레임·리콜·재판정)', order: 60 },
      { code: 'C10', codeName: '의심자재등록 → 보류', order: 70 },
      { code: 'C14', codeName: '판정 → PQC 검사 필요(합격판정개수 초과)', order: 80 },
      { code: 'C15', codeName: 'PQC 검사 필요 → Release(전수 재검 양품)', order: 90 },
    ],
  },
  {
    // trace.lot.status_code — 품질 판정 축.
    //
    // 이 컬럼은 baseline부터 있었는데 값 집합이 어디에도 없었고, DEFAULT가 'ACTIVE'로
    // 박혀 있었다. 'ACTIVE'는 이 넷 중 어느 것도 아닌 생명주기 축의 어휘다 — 같은
    // 마이그레이션에서 DEFAULT를 없앴고, 여기서 실제 값 집합을 세운다.
    //
    // 값 표기는 공유계약 G-2가 정한 것을 그대로 쓴다.
    //
    // ⛔ '완료'·'미달 마감'·'폐번'은 이 축의 값이 아니다 — 완료는 trace.lot.completed_at
    //    (시각)이, 폐번은 lifecycle_status_code가 담는다.
    groupCode: 'LOT_STATUS',
    groupName: 'LOT 품질 판정',
    isSystemOwned: true,
    values: [
      { code: 'NORMAL', codeName: '정상', order: 10 },
      { code: 'INSPECTION_PENDING', codeName: '검사 대기', order: 20 },
      { code: 'DEFECTIVE', codeName: '불량', order: 30 },
      { code: 'SCRAPPED', codeName: '폐기', order: 40 },
    ],
  },
  {
    // 판정유형. 통제 속성(mdm.judgment_type_control)이 이 그룹의 코드값에 붙는다.
    //
    // ⛔ 값을 넣지 않는다 — 설계팀이 통제 속성 7칸 사양은 보냈으나 *판정유형 값 목록*
    //    자체는 아직 오지 않았다(2026-09-01 회신 E-1). 그룹만 세우는 이유는 후속
    //    마이그레이션이 code_value를 가리키는 표를 붙이기 때문이고, 지금 잠가 두어야
    //    목록이 오기 전에 고객이 임의 값을 넣지 못한다.
    //
    // 잠그는 근거: blocks_issue·blocks_shipment·blocks_picking이 출고·출하·피킹을 막고
    // requires_approval이 결재를 태운다 — G-31 마스터안전형이 아니다.
    groupCode: 'JUDGMENT_TYPE',
    groupName: '판정 유형',
    isSystemOwned: true,
    values: [],
  },

  // ── 계약 지정 코드 그룹 시드 (#45 · #46) ─────────────────────────────────
  // 계약이 codeGroupCode= 로 이름을 지정한 그룹 38개 중 시드가 비어 있던 자리다.
  // 값은 설계가 #45(29그룹 133값) · #46(13그룹 40값) 본문에 확정해 둔 것을 그대로 쓴다.
  // 이번 커밋은 «신설»만 담는다 — 이름이 겹치면서 값이 다른 7그룹은 별도 커밋이다.
  {
    groupCode: 'GOODS_ISSUE_REASON',
    groupName: '출고 사유',
    values: [
      { code: 'IQC_FAIL', codeName: 'IQC 불합격', order: 10 },
      { code: 'OVER_RECEIPT', codeName: '초과 입하', order: 20 },
      { code: 'DEFECT_AFTER_RECEIPT', codeName: '입고 후 하자', order: 30 },
      { code: 'WRONG_SHIPMENT', codeName: '오배송', order: 40 },
      { code: 'OTHER', codeName: '기타', order: 50 },
    ],
  },
  {
    groupCode: 'INBOUND_VARIANCE_REASON',
    groupName: '입하 차이 사유',
    values: [
      { code: 'DAMAGED', codeName: '파손', order: 10 },
      { code: 'MISLABELED', codeName: '라벨 오류', order: 20 },
      { code: 'SUPPLIER_MISSHIP', codeName: '공급사 오배송', order: 30 },
      { code: 'PACKAGING_DEFECT', codeName: '포장 불량', order: 40 },
      { code: 'OTHER', codeName: '기타', order: 50 },
    ],
  },
  {
    groupCode: 'INVENTORY_ADJUSTMENT_REASON',
    groupName: '재고조정 사유',
    values: [
      { code: 'COUNT_VARIANCE', codeName: '정기 실사 차이 조정', order: 10 },
      { code: 'TRANSPORT_DAMAGE', codeName: '운반 파손', order: 20 },
      { code: 'HOPPER_MEASUREMENT', codeName: '호퍼 실측 반영', order: 30 },
      { code: 'SYSTEM_ERROR_CORRECTION', codeName: '전산 오류 정정', order: 40 },
      { code: 'OTHER', codeName: '기타', order: 50 },
    ],
  },
  {
    groupCode: 'PUTAWAY_TASK_TEMPORARY_REASON',
    groupName: '임시 위치 적재 사유',
    values: [
      { code: 'NO_SPACE', codeName: '정위치 포화', order: 10 },
      { code: 'INSPECTION_HOLD', codeName: '검사 대기', order: 20 },
      { code: 'LOCATION_UNASSIGNED', codeName: '위치 미지정', order: 30 },
      { code: 'OTHER', codeName: '기타', order: 40 },
    ],
  },
  {
    groupCode: 'SUBSTITUTE_LOT_REASON',
    groupName: '대체 LOT 입력 사유',
    values: [
      { code: 'NO_LABEL', codeName: '라벨 미부착', order: 10 },
      { code: 'LABEL_DAMAGED', codeName: '라벨 훼손·식별 불가', order: 20 },
      { code: 'FORMAT_UNRECOGNIZED', codeName: 'LOT 번호 형식 인식 불가', order: 30 },
      { code: 'BULK_UNLABELED', codeName: '벌크 입고(개별 라벨 없음)', order: 40 },
      { code: 'OTHER', codeName: '기타', order: 50 },
    ],
  },
  {
    groupCode: 'VARIANCE_REASON',
    groupName: '재고실사·생산창고입고 차이 사유',
    values: [
      { code: 'MISPLACED', codeName: '오적치(위치 착오)', order: 10 },
      { code: 'DAMAGED_IN_TRANSIT', codeName: '운반 중 파손', order: 20 },
      { code: 'SPILL', codeName: '유출·누출', order: 30 },
      { code: 'COUNT_ERROR', codeName: '카운트 오류', order: 40 },
      { code: 'THEFT_LOSS', codeName: '도난·분실', order: 50 },
      { code: 'EVAPORATION_LOSS', codeName: '증발·감모', order: 60 },
    ],
  },
  {
    groupCode: 'INBOUND_RECEIPT_EXCEPTION_TYPE',
    groupName: '입하 예외 유형',
    values: [
      { code: 'CUSTOMER_SUPPLY', codeName: '고객사급', order: 10 },
      { code: 'FREE_SAMPLE', codeName: '무상샘플', order: 20 },
      { code: 'URGENT_RECEIPT', codeName: '긴급입하', order: 30 },
      { code: 'OVER_DELIVERY', codeName: '초과입하', order: 40 },
    ],
  },
  {
    groupCode: 'HANDLING_UNIT_TYPE',
    groupName: '취급단위 유형',
    values: [
      { code: 'BOX', codeName: '박스', order: 10 },
      { code: 'CART', codeName: '대차', order: 20 },
      { code: 'PALLET', codeName: '팔레트', order: 30 },
    ],
  },
  {
    groupCode: 'LOT_EXTERNAL_IDENTIFIER_TYPE',
    groupName: 'LOT 외부식별자 유형',
    values: [
      { code: 'SUPPLIER_LOT', codeName: '공급사LOT', order: 10 },
      { code: 'ERP_LOT', codeName: 'ERP LOT', order: 20 },
      { code: 'CUSTOMER_LOT', codeName: '고객LOT', order: 30 },
      { code: 'SUBCONTRACTOR_LOT', codeName: '외주처LOT', order: 40 },
    ],
  },
  {
    groupCode: 'OWNERSHIP_TYPE',
    groupName: '재고 소유 구분',
    values: [
      { code: 'OWNED', codeName: '자사소유', order: 10 },
      { code: 'CUSTOMER_SUPPLIED', codeName: '고객지급품', order: 20 },
      { code: 'CONSIGNMENT', codeName: '위탁재고', order: 30 },
    ],
  },
  {
    groupCode: 'PICKING_TYPE',
    groupName: '피킹 유형',
    values: [
      { code: 'MATERIAL', codeName: '자재출고피킹', order: 10 },
      { code: 'SHIPMENT', codeName: '제품출하피킹', order: 20 },
    ],
  },
  {
    groupCode: 'RESERVATION_TYPE',
    groupName: '재고예약 유형',
    values: [
      { code: 'MATERIAL', codeName: '자재출고예약', order: 10 },
      { code: 'SHIPMENT', codeName: '출하예약', order: 20 },
      { code: 'PRODUCTION', codeName: '생산투입예약', order: 30 },
    ],
  },
  {
    groupCode: 'INVENTORY_COUNT_TYPE',
    groupName: '재고실사 유형',
    values: [
      { code: 'PERIODIC', codeName: '정기', order: 10 },
      { code: 'ADHOC', codeName: '수시', order: 20 },
      { code: 'CYCLE', codeName: '순환', order: 30 },
    ],
  },
  {
    groupCode: 'CONTROL_OVERRIDE_REASON',
    groupName: '통제 우회 사유',
    values: [
      { code: 'EMERGENCY_WORK_ORDER', codeName: '긴급작업지시 우회', order: 10 },
      { code: 'OTHER', codeName: '기타(관리자 승인 예외)', order: 20 },
    ],
  },
  {
    groupCode: 'PRODUCTION_PLAN_SPLIT_REASON',
    groupName: '생산계획 분할 사유',
    values: [
      { code: 'ENGINEERING_CHANGE', codeName: '설계변경(ECN) 반영', order: 10 },
      { code: 'PART_SHORTAGE', codeName: '부품 결품 대체', order: 20 },
      { code: 'QUALITY_ISSUE', codeName: '품질 이슈로 인한 부품 교체', order: 30 },
      { code: 'SUPPLIER_CHANGE', codeName: '공급업체 변경', order: 40 },
      { code: 'OTHER', codeName: '기타', order: 50 },
    ],
  },
  {
    groupCode: 'WORK_ORDER_CANCEL_REASON',
    groupName: 'WO 취소 사유',
    values: [
      { code: 'CUSTOMER_ORDER_CHANGE', codeName: '고객 주문(P/O) 변경', order: 10 },
      { code: 'PLAN_CHANGE', codeName: '생산계획 변경', order: 20 },
      { code: 'MATERIAL_SHORTAGE', codeName: '자재 결품', order: 30 },
      { code: 'EQUIPMENT_FAILURE', codeName: '설비 고장', order: 40 },
      { code: 'QUALITY_ISSUE', codeName: '품질 이슈', order: 50 },
      { code: 'OTHER', codeName: '기타', order: 60 },
    ],
  },
  {
    groupCode: 'WORK_ORDER_COMPLETION_VARIANCE_REASON',
    groupName: 'WO 완료 미달·초과 사유',
    values: [
      { code: 'MATERIAL_SHORTAGE', codeName: '자재 결품', order: 10 },
      { code: 'EQUIPMENT_FAILURE', codeName: '설비 고장', order: 20 },
      { code: 'QUALITY_DEFECT', codeName: '품질 불량 다발', order: 30 },
      { code: 'PLAN_CHANGE', codeName: '생산계획 변경', order: 40 },
      { code: 'OVER_PRODUCTION', codeName: '초과 생산(계획 대비 초과 달성)', order: 50 },
      { code: 'OTHER', codeName: '기타', order: 60 },
    ],
  },
  {
    groupCode: 'WORK_SESSION_EVENT_REASON',
    groupName: '작업세션 이벤트 사유',
    values: [
      { code: 'URGENT_ORDER_INTERRUPT', codeName: '긴급 오더 끼어들기', order: 10 },
      { code: 'EQUIPMENT_FAILURE', codeName: '설비 고장', order: 20 },
      { code: 'TOOL_FAILURE', codeName: '도구 고장', order: 30 },
      { code: 'MATERIAL_SHORTAGE', codeName: '자재 결품', order: 40 },
      { code: 'MOLD_CHANGE', codeName: '금형 교체', order: 50 },
      { code: 'QUALITY_ISSUE', codeName: '품질 이슈', order: 60 },
      { code: 'OTHER', codeName: '기타', order: 70 },
    ],
  },
  {
    groupCode: 'WORK_CALENDAR_DAY_REASON',
    groupName: '근무캘린더 예외일 사유',
    values: [
      { code: 'PUBLIC_HOLIDAY', codeName: '공휴일', order: 10 },
      { code: 'COMPANY_FOUNDING_DAY', codeName: '창립기념일', order: 20 },
      { code: 'SUMMER_VACATION', codeName: '하계휴가', order: 30 },
      { code: 'PLANNED_MAINTENANCE', codeName: '설비 정기보전 휴무', order: 40 },
      { code: 'MAKEUP_WORKING_DAY', codeName: '휴일 대체 근무일', order: 50 },
      { code: 'OTHER', codeName: '기타', order: 60 },
    ],
  },
  {
    groupCode: 'LOT_HOLD_REASON',
    groupName: 'LOT 보류 사유',
    values: [
      { code: 'INCOMING_INSPECTION_WAIT', codeName: '수입검사 대기', order: 10 },
      { code: 'FOREIGN_MATTER_SUSPECTED', codeName: '이물 혼입 의심', order: 20 },
      { code: 'DIMENSION_ABNORMAL', codeName: '치수 이상', order: 30 },
      { code: 'APPEARANCE_ABNORMAL', codeName: '외관 이상', order: 40 },
      { code: 'CLAIM_RECALL', codeName: '클레임·리콜', order: 50 },
      { code: 'OTHER', codeName: '기타', order: 60 },
    ],
  },
  {
    groupCode: 'DOWNTIME_REASON',
    groupName: '설비 비가동 사유',
    values: [
      { code: 'EQUIPMENT_FAILURE', codeName: '설비 고장', order: 10 },
      { code: 'MOLD_CHANGE', codeName: '금형 교체', order: 20 },
      { code: 'MATERIAL_WAIT', codeName: '자재 대기', order: 30 },
      { code: 'LABOR_WAIT', codeName: '작업자 대기', order: 40 },
      { code: 'PREVENTIVE_MAINTENANCE', codeName: '예방보전', order: 50 },
      { code: 'OTHER', codeName: '기타', order: 60 },
    ],
  },
  {
    groupCode: 'INSPECTION_ITEM_SPEC_METHOD',
    groupName: '검사 항목 판정 방법',
    values: [
      { code: 'MEASUREMENT', codeName: '측정', order: 10 },
      { code: 'VISUAL', codeName: '외관', order: 20 },
      { code: 'FUNCTIONAL', codeName: '기능검사', order: 30 },
    ],
  },
  {
    groupCode: 'INSPECTION_SAMPLING_METHOD',
    groupName: '검사 샘플링 방식',
    values: [
      { code: 'FULL_INSPECTION', codeName: '전수검사', order: 10 },
      { code: 'SAMPLE_BY_UNIT', codeName: '샘플링(제품 단위)', order: 20 },
      { code: 'SAMPLE_BY_LOT', codeName: '샘플링(LOT 단위)', order: 30 },
    ],
  },
  {
    groupCode: 'REISSUE_REASON',
    groupName: '출력물 재발행 사유',
    values: [
      { code: 'DAMAGED', codeName: '훼손', order: 10 },
      { code: 'LOST', codeName: '분실', order: 20 },
      { code: 'PRINT_FAILURE', codeName: '인쇄 실패', order: 30 },
      { code: 'PACKAGING', codeName: '포장', order: 40 },
      { code: 'QUANTITY_CHANGE', codeName: '재구성으로 수량 변경', order: 50 },
    ],
  },
  {
    // ⚠ 잠금은 «우리 판단»이다. 설계가 명시하지 않았으나 검사 의뢰 상태는 상태 기계이고,
    // 설계가 WORK_ORDER_STATUS 를 같은 이유로 「G-31 이 아니다」로 못박았다. 과잉 잠금은
    // 불편에 그치지만 놓친 잠금은 상태 기계를 깬다 — 이견 있으면 내린다.
    groupCode: 'INSPECTION_REQUEST_STATUS',
    groupName: '검사 의뢰 상태',
    isSystemOwned: true,
    values: [
      { code: 'REQUESTED', codeName: '대기', order: 10 },
      { code: 'IN_PROGRESS', codeName: '진행', order: 20 },
      { code: 'COMPLETED', codeName: '완료', order: 30 },
      { code: 'SKIPPED', codeName: '생략', order: 40 },
      { code: 'CANCELLED', codeName: '취소', order: 50 },
    ],
  },
  {
    // 검사 결과의 수량 세 칸(accepted_qty·rejected_qty·held_qty)과 1:1이다.
    // ck_inspection_result_qty(셋의 합 = 검사 수량)가 울타리라 값을 늘리면 그 제약이 깨진다.
    groupCode: 'INSPECTION_RESULT_OVERALL_JUDGMENT',
    groupName: '검사 종합 판정',
    isSystemOwned: true,
    values: [
      { code: 'ACCEPTED', codeName: '합격', order: 10 },
      { code: 'REJECTED', codeName: '불합격', order: 20 },
      { code: 'HELD', codeName: '보류', order: 30 },
    ],
  },
  {
    // 항목 판정에는 「보류」가 없다 — 보류는 검사 «결과» 수준의 개념이고
    // 항목은 규격에 드는지 아닌지 둘뿐이다. 종합 판정과 합치지 않는다.
    groupCode: 'INSPECTION_MEASUREMENT_JUDGMENT',
    groupName: '검사 항목 판정',
    isSystemOwned: true,
    values: [
      { code: 'ACCEPTED', codeName: '합격', order: 10 },
      { code: 'REJECTED', codeName: '불합격', order: 20 },
    ],
  },
  {
    // 측정치의 값 칸 셋(numeric_value·text_value·boolean_value)과 1:1이다.
    // 넷째 값은 담을 칸이 없다 — ck_inspection_measurement 가 num_nonnulls <= 1 이다.
    groupCode: 'INSPECTION_ITEM_SPEC_DATA_TYPE',
    groupName: '검사 항목 데이터 유형',
    isSystemOwned: true,
    values: [
      { code: 'NUMERIC', codeName: '수치', order: 10 },
      { code: 'TEXT', codeName: '텍스트', order: 20 },
      { code: 'BOOLEAN', codeName: '불리언', order: 30 },
    ],
  },
  {
    groupCode: 'LOT_TYPE',
    groupName: 'LOT 유형',
    values: [
      { code: 'MATERIAL', codeName: '자재', order: 10 },
      { code: 'PRODUCTION', codeName: '생산', order: 20 },
      { code: 'PRODUCT', codeName: '제품', order: 30 },
    ],
  },
  {
    groupCode: 'EQUIPMENT_INSPECTION_TYPE',
    groupName: '설비 점검 유형',
    values: [
      { code: 'DAILY', codeName: '일상', order: 10 },
      { code: 'MONTHLY', codeName: '정기', order: 20 },
      { code: 'MAINTENANCE', codeName: '보전', order: 30 },
    ],
  },
  {
    groupCode: 'EQUIPMENT_INSPECTION_JUDGMENT_METHOD',
    groupName: '설비 점검 판정 방식',
    values: [
      { code: 'VISUAL', codeName: '육안', order: 10 },
      { code: 'MEASUREMENT', codeName: '측정값', order: 20 },
    ],
  },
  {
    groupCode: 'QUALITY_INSPECTION_TYPE',
    groupName: '품질 검사 유형',
    values: [
      { code: 'IQC', codeName: '수입검사', order: 10 },
      { code: 'PQC', codeName: '공정검사', order: 20 },
      { code: 'OQC', codeName: '출하검사', order: 30 },
    ],
  },
  {
    groupCode: 'CYCLE_TYPE',
    groupName: '주기 단위',
    values: [
      { code: 'DAY', codeName: '일', order: 10 },
      { code: 'WEEK', codeName: '주', order: 20 },
      { code: 'MONTH', codeName: '월', order: 30 },
      { code: 'YEAR', codeName: '년', order: 40 },
    ],
  },
  {
    groupCode: 'INSTRUMENT_TYPE',
    groupName: '계측기 유형',
    values: [
      { code: 'CALIPER', codeName: '캘리퍼스', order: 10 },
      { code: 'MICROMETER', codeName: '마이크로미터', order: 20 },
      { code: 'GAUGE', codeName: '게이지', order: 30 },
    ],
  },
];

/**
 * 기본 채번규칙 — 공장을 가리지 않는 전역 규칙(plant_id=null)이다.
 *
 * 공장별로 다른 번호 체계가 필요해지면 관리 화면에서 공장 지정 규칙을 더한다.
 * 발번기가 「지정된 축이 많을수록 이긴다」로 고르므로 전역 규칙은 그대로 둬도 된다.
 */
/**
 * 다형 참조 대상 등록부 — app.entity_type_registry.
 *
 * 물리에 다형 참조 쌍이 27개 있다(`*_type_code` + `*_id`). 유형 코드가 어느 표의 어느
 * 컬럼을 가리키는지 적어 두는 곳이 이 표인데 비어 있었다.
 *
 * 비어 있으면 두 가지가 막힌다 — app.localized_text·integration.record_provenance 가
 * entity_type_code 로 이 표를 FK 참조하므로 «어떤 행도 INSERT 할 수 없다». 그리고
 * 유형 목록이 없으면 target_id 만으로 걸러 다른 유형의 같은 번호가 섞인다.
 *
 * 값은 이미 확정된 것만 담는다 — 채번 문서유형 10종(DOCUMENT_TYPE 시드)과 설계가
 * 첨부 대상으로 확정한 4종, 그리고 예비품 출고의 원천인 보전지시다. 완결 목록이
 * 아니며 쓰이는 유형이 늘면 함께 는다.
 */
const ENTITY_TYPES = [
  { code: 'LOT', schema: 'trace', table: 'lot', idColumn: 'lot_id' },
  { code: 'WORK_ORDER', schema: 'production', table: 'work_order', idColumn: 'work_order_id' },
  {
    code: 'PRODUCTION_RESULT',
    schema: 'production',
    table: 'production_result',
    idColumn: 'production_result_id',
  },
  {
    code: 'INSPECTION_REQUEST',
    schema: 'quality',
    table: 'inspection_request',
    idColumn: 'inspection_request_id',
  },
  {
    code: 'INSPECTION_RESULT',
    schema: 'quality',
    table: 'inspection_result',
    idColumn: 'inspection_result_id',
  },
  {
    code: 'GOODS_RECEIPT',
    schema: 'logistics',
    table: 'goods_receipt',
    idColumn: 'goods_receipt_id',
  },
  { code: 'GOODS_ISSUE', schema: 'logistics', table: 'goods_issue', idColumn: 'goods_issue_id' },
  { code: 'SHIPMENT', schema: 'logistics', table: 'shipment', idColumn: 'shipment_id' },
  {
    code: 'STOCK_TRANSFER',
    schema: 'logistics',
    table: 'stock_transfer',
    idColumn: 'stock_transfer_id',
  },
  {
    code: 'NONCONFORMANCE',
    schema: 'quality',
    table: 'nonconformance',
    idColumn: 'nonconformance_id',
  },
  { code: 'NOTICE', schema: 'app', table: 'notice', idColumn: 'notice_id' },
  { code: 'WAREHOUSE', schema: 'mdm', table: 'warehouse', idColumn: 'warehouse_id' },
  { code: 'BREAKDOWN', schema: 'maintenance', table: 'breakdown', idColumn: 'breakdown_id' },
  {
    code: 'INBOUND_RECEIPT',
    schema: 'logistics',
    table: 'inbound_receipt',
    idColumn: 'inbound_receipt_id',
  },
  // ⚠ INBOUND_RECEIPT(입하 «건»)와 다른 축이다. 첨부는 건에 붙고 LOT 원천은 라인을
  //    가리킨다 — 계약이 「발번 단위는 건이 아니라 라인」으로 확정했고
  //    InboundReceiptLine.lotId 가 그 짝이다(P-01-01 §3-6 · omf-mes#326).
  //    둘을 갈지 않고 함께 둔다.
  {
    code: 'INBOUND_RECEIPT_LINE',
    schema: 'logistics',
    table: 'inbound_receipt_line',
    idColumn: 'inbound_receipt_line_id',
  },
  // trace.lot.source_type_code 의 나머지 확정값. sourceId 는 등록 건 자체를 가리킨다.
  { code: 'RECYCLE_ENTRY', schema: 'logistics', table: 'recycle_entry', idColumn: 'recycle_entry_id' },
  {
    code: 'MAINTENANCE_ORDER',
    schema: 'maintenance',
    table: 'maintenance_order',
    idColumn: 'maintenance_order_id',
  },
];

const NUMBERING_RULES = [
  {
    documentTypeCode: 'PRODUCTION_RESULT',
    pattern: 'PR-{YYMMDD}-{SEQ4}',
    resetCycleCode: 'DAILY',
  },
];

/**
 * 역할 프리셋 — REQ-PR-0015 확정 전까지 쓸 임시 골격.
 * 워크플로우 문서의 실제 담당 주체를 그대로 옮겼다. 고객이 부서·권한 범위를 확정하면
 * 이 표를 갈아끼운다.
 */
/**
 * 더는 쓰지 않는 코드 그룹. 값만 내리는 `retired` 와 달리 그룹째 내린다.
 * ⛔ 지우지 않는다 — 이미 그 값을 쓰고 있는 행이 있을 수 있고, 코드 값에는 FK 가 없어
 * 지우면 그 행이 가리키던 뜻이 사라진다.
 */
const RETIRED_GROUPS = [
  // 「계정 상태」 축이 APP_USER_STATUS(인사 상태)와 app_user.is_active 둘로 갈렸다.
  'USER_STATUS',
  // ⛔ 기능 권한은 공통코드가 아니다 — 「앱 기능 목록이라 고객이 W-06-06 에서 늘리거나
  // 지울 수 없다」(계약 GET /app/permissions). 값은 화면 코드와 1:1 이고 앱 상수에 있다
  // (src/common/permissions/permissions.ts · 117건). 여기 두면 고객이 편집할 수 있는
  // 것처럼 보이고, 편집해도 아무 효과가 없다.
  'PERMISSION',
];

/**
 * 역할. 설계 확정 4종(`design/schema/generators/권한목록.md` · 사용자 결정 2026-09-01).
 * 고객이 운영 중 늘리고 고치고 지운다 — ⭐ 화면 동작은 역할 «이름»이 아니라 권한에 걸리므로
 * 이 넷은 출발점일 뿐이다.
 *
 * ⛔ 권한은 부트스트랩에 필요한 것만 심는다. 역할별 권한 배분은 업무 결정이고 설계가 매트릭스를
 * 내려 준 적이 없다 — 여기서 지어내면 그것이 사실상의 정책이 된다. 나머지는 관리자가
 * `W-CO-02` 에서 부여한다.
 */
const ROLES = [
  {
    code: 'ROLE_WORKER',
    name: '실무자',
    permissions: [],
  },
  {
    code: 'ROLE_SITE_MGR',
    name: '현장 관리자',
    permissions: [],
  },
  {
    code: 'ROLE_EXEC_MGR',
    name: '경영 관리자',
    permissions: [],
  },
  {
    // ⛔ 이 셋이 없으면 아무도 아무 권한을 줄 수 없다 — 로그인하고, 비밀번호를 바꾸고,
    // 권한을 부여하는 최소 집합이다(권한목록.md 「최초 관리자」).
    code: 'ROLE_SYS_ADMIN',
    name: '시스템 운영자',
    permissions: ['W-CO-01', 'W-CO-02', 'W-CO-10'],
  },
];

/** 더는 쓰지 않는 역할. 부여 기록은 지우지 않고 역할만 내린다(계약 `:deactivate` 와 같은 뜻). */
const RETIRED_ROLES = [
  'SYSTEM_ADMIN',
  'PRODUCTION_MANAGER',
  'QUALITY_MANAGER',
  'EQUIPMENT_MANAGER',
  'LOGISTICS_MANAGER',
  'VIEWER',
];

/**
 * 기본 단위(UoM). 품목·로케이션 수용량이 참조한다.
 * decimal_scale = 수량 소수 자릿수(DB 제약 0~6).
 */
const UOMS = [
  { code: 'EA', name: '개', scale: 0 },
  { code: 'KG', name: '킬로그램', scale: 3 },
  { code: 'G', name: '그램', scale: 3 },
  { code: 'M', name: '미터', scale: 3 },
  { code: 'BOX', name: '박스', scale: 0 },
  { code: 'PLT', name: '파렛트', scale: 0 },
];

async function main(): Promise<void> {
  for (const uom of UOMS) {
    await prisma.uom.upsert({
      where: { uom_code: uom.code },
      update: { uom_name: uom.name, decimal_scale: uom.scale, is_active: true },
      create: { uom_code: uom.code, uom_name: uom.name, decimal_scale: uom.scale },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`seeded UOM (${UOMS.length})`);

  for (const group of SEED) {
    const isSystemOwned = group.isSystemOwned ?? false;
    const retired = group.retired ?? [];

    // 같은 코드가 values와 retired에 함께 있으면 방금 세운 값을 곧바로 내린다 — 물러남이
    // upsert 뒤에 돌기 때문이다. 로그는 「9 values」로 정상처럼 보여 눈에 띄지 않으므로
    // 여기서 세운다.
    const conflicting = group.values.filter((value) => retired.includes(value.code));
    if (conflicting.length > 0) {
      throw new Error(
        `${group.groupCode}: ${conflicting.map((value) => value.code).join(', ')} 가 values와 retired에 함께 있다`,
      );
    }

    const saved = await prisma.code_group.upsert({
      where: { group_code: group.groupCode },
      update: { group_name: group.groupName, is_active: true, is_system_owned: isSystemOwned },
      create: {
        group_code: group.groupCode,
        group_name: group.groupName,
        is_system_owned: isSystemOwned,
      },
    });

    for (const value of group.values) {
      await prisma.code_value.upsert({
        where: {
          code_group_id_code: { code_group_id: saved.code_group_id, code: value.code },
        },
        update: { code_name: value.codeName, display_order: value.order, is_active: true },
        create: {
          code_group_id: saved.code_group_id,
          code: value.code,
          code_name: value.codeName,
          display_order: value.order,
        },
      });
    }

    // 물러난 값을 내린다. upsert만으로는 목록에서 뺀 값이 DB에 그대로 남는다.
    const retiredCount = retired.length
      ? (
          await prisma.code_value.updateMany({
            where: { code_group_id: saved.code_group_id, code: { in: retired }, is_active: true },
            data: { is_active: false },
          })
        ).count
      : 0;

    const marks = [isSystemOwned ? '시스템 소유' : '', retiredCount ? `물러남 ${retiredCount}` : '']
      .filter(Boolean)
      .join(' · ');
    // eslint-disable-next-line no-console
    console.log(
      `seeded ${group.groupCode} (${group.values.length} values${marks ? ` · ${marks}` : ''})`,
    );
  }

  // 쓰지 않는 코드 그룹을 내린다. 값과 달리 그룹째다 — 값만 내리면 빈 그룹이 화면의
  // 그룹 선택 목록에 남는다.
  const retiredGroups = await prisma.code_group.updateMany({
    where: { group_code: { in: RETIRED_GROUPS }, is_active: true },
    data: { is_active: false },
  });
  if (retiredGroups.count > 0) {
    // eslint-disable-next-line no-console
    console.log(`retired code group ${retiredGroups.count}`);
  }

  await seedEntityTypes();
  await seedNumberingRules();
  await seedRoles();
  await seedAdmin();
}

async function seedEntityTypes(): Promise<void> {
  for (const entity of ENTITY_TYPES) {
    await prisma.entity_type_registry.upsert({
      where: { entity_type_code: entity.code },
      update: {
        schema_name: entity.schema,
        table_name: entity.table,
        id_column_name: entity.idColumn,
        is_active: true,
      },
      create: {
        entity_type_code: entity.code,
        schema_name: entity.schema,
        table_name: entity.table,
        id_column_name: entity.idColumn,
      },
    });
  }
  // eslint-disable-next-line no-console
  console.log(`seeded entity_type_registry (${ENTITY_TYPES.length})`);
}

/**
 * 전역 채번규칙. numbering_rule에는 유니크 제약이 없어 upsert를 쓸 수 없으므로
 * (문서유형 × 전역) 조합을 직접 찾아 없을 때만 만든다 — 시드를 다시 돌려도 늘지 않는다.
 */
async function seedNumberingRules(): Promise<void> {
  for (const rule of NUMBERING_RULES) {
    const existing = await prisma.numbering_rule.findFirst({
      where: {
        document_type_code: rule.documentTypeCode,
        plant_id: null,
        lot_type_code: null,
      },
    });

    if (existing) {
      await prisma.numbering_rule.update({
        where: { numbering_rule_id: existing.numbering_rule_id },
        data: { pattern: rule.pattern, reset_cycle_code: rule.resetCycleCode, is_active: true },
      });
    } else {
      await prisma.numbering_rule.create({
        data: {
          document_type_code: rule.documentTypeCode,
          pattern: rule.pattern,
          reset_cycle_code: rule.resetCycleCode,
        },
      });
    }

    // eslint-disable-next-line no-console
    console.log(`seeded 채번규칙 ${rule.documentTypeCode} (${rule.pattern})`);
  }
}

/**
 * 최초 관리자 부트스트랩.
 *
 * 비밀번호는 ADMIN_INITIAL_PASSWORD로 주고, 없으면 무작위 생성해 **1회만** 출력한다.
 * 하드코딩된 기본 비밀번호를 두지 않기 위해서다 — 그런 값은 운영까지 그대로 살아남는다.
 * 어느 경우든 must_change_password=true라 첫 로그인에서 변경해야 한다.
 *
 * 해시 형식은 src/auth/password.service.ts와 같아야 한다(scrypt$N$r$p$salt$hash).
 */
/**
 * 역할·권한 매핑. **admin 존재 여부와 무관하게 매번 돌아야 한다** —
 * 권한 코드가 바뀌었는데 seedAdmin의 early-return에 묶여 있으면 기존 설치가 갱신되지 않는다.
 *
 * 목록에 없는 권한은 지운다. 그러지 않으면 권한을 회수해도 예전 부여가 남는다.
 */
async function seedRoles(): Promise<void> {
  for (const role of ROLES) {
    const saved = await prisma.role.upsert({
      where: { role_code: role.code },
      update: { role_name: role.name, is_active: true },
      create: { role_code: role.code, role_name: role.name },
    });

    for (const code of role.permissions) {
      await prisma.role_permission.upsert({
        where: { role_id_permission_code: { role_id: saved.role_id, permission_code: code } },
        update: {},
        create: { role_id: saved.role_id, permission_code: code },
      });
    }
    // ⛔ 목록에 없는 부여를 지우지 않는다. 역할별 권한은 고객이 W-CO-02 에서 정하는
    // 것이고(설계 확정 2026-09-01), 지우면 시드를 다시 돌릴 때마다 그 설정이 날아간다.
    // 시드는 부트스트랩에 필요한 것이 «있는지»만 본다.

    // eslint-disable-next-line no-console
    console.log(`seeded role ${role.code} (${role.permissions.length} permissions)`);
  }

  // 쓰지 않는 역할은 내리기만 한다. 계약이 그렇게 정했다 — 「중지된 역할은 권한 판정에서
  // 제외되고 부여 기록은 지우지 않는다. 지우면 다시 켰을 때 누구에게 줬는지가 사라진다」
  // (POST /app/roles/{roleId}:deactivate).
  const retired = await prisma.role.updateMany({
    where: { role_code: { in: RETIRED_ROLES }, is_active: true },
    data: { is_active: false },
  });
  if (retired.count > 0) {
    // eslint-disable-next-line no-console
    console.log(`retired role ${retired.count}`);
  }
}

async function seedAdmin(): Promise<void> {
  const LOGIN_ID = 'admin';
  const existing = await prisma.app_user.findUnique({
    where: { login_id: LOGIN_ID },
    include: { user_credential: true },
  });
  const admin =
    existing ??
    (await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '시스템 관리자', status_code: 'EMPLOYED' },
    }));

  // ⛔ 역할 부여는 «자격증명이 이미 있어도» 돈다. 역할 코드가 바뀐 판(6종 → 확정 4종)에서
  // 여기서 돌아 나가면 기존 설치의 관리자가 내려간 역할만 쥔 채 유효 권한 0이 되고,
  // 그러면 아무도 아무 권한을 줄 수 없다(권한목록.md 「최초 관리자」).
  const adminRole = await prisma.role.findUniqueOrThrow({ where: { role_code: 'ROLE_SYS_ADMIN' } });
  await prisma.user_role.upsert({
    where: { app_user_id_role_id: { app_user_id: admin.app_user_id, role_id: adminRole.role_id } },
    update: {},
    create: { app_user_id: admin.app_user_id, role_id: adminRole.role_id },
  });

  if (existing?.user_credential) {
    // eslint-disable-next-line no-console
    console.log('admin 자격증명이 이미 있어 비밀번호는 그대로 두고 역할만 맞췄다');
    return;
  }

  const password = process.env.ADMIN_INITIAL_PASSWORD ?? randomBytes(12).toString('base64url');
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 2 ** 15 * 8 * 2 }, (e, d) =>
      e ? reject(e) : resolve(d),
    ),
  );
  const hash = ['scrypt', 2 ** 15, 8, 1, salt.toString('base64'), derived.toString('base64')].join('$');

  await prisma.user_credential.create({
    data: { app_user_id: admin.app_user_id, password_hash: hash, must_change_password: true },
  });

  // eslint-disable-next-line no-console
  console.log(
    process.env.ADMIN_INITIAL_PASSWORD
      ? 'seeded admin (비밀번호=ADMIN_INITIAL_PASSWORD, 첫 로그인에서 변경 필요)'
      : `seeded admin — 초기 비밀번호: ${password}  ← 지금 기록하십시오. 다시 표시되지 않습니다.`,
  );
}

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  })
  .finally(() => void prisma.$disconnect());
