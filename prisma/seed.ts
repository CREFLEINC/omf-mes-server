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
    groupCode: 'ITEM_TYPE',
    groupName: '품목구분',
    values: [
      { code: 'RAW', codeName: '자재', order: 10 },
      { code: 'SEMI', codeName: '반제품', order: 20 },
      { code: 'FG', codeName: '제품', order: 30 },
      { code: 'MDSE', codeName: '상품', order: 40 },
      { code: 'DEV', codeName: '개발품(시제품)', order: 50 },
    ],
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
    // 기술스택 결정 16의 폼팩터 3종: 관리 웹 / POP 패널 PC / 모바일 스캐너
    groupCode: 'TERMINAL_TYPE',
    groupName: '단말 유형',
    values: [
      { code: 'ADMIN_WEB', codeName: '관리 웹', order: 10 },
      { code: 'POP', codeName: 'POP 단말', order: 20 },
      { code: 'MOBILE', codeName: '모바일 스캐너', order: 30 },
    ],
  },
  {
    groupCode: 'TERMINAL_STATUS',
    groupName: '단말 상태',
    values: [
      { code: 'NORMAL', codeName: '정상', order: 10 },
      { code: 'MAINTENANCE', codeName: '점검중', order: 20 },
      { code: 'DISPOSED', codeName: '폐기', order: 30 },
    ],
  },
  {
    groupCode: 'USER_STATUS',
    groupName: '계정 상태',
    values: [
      { code: 'ACTIVE', codeName: '사용', order: 10 },
      { code: 'SUSPENDED', codeName: '정지', order: 20 },
      { code: 'DISABLED', codeName: '해지', order: 30 },
    ],
  },
  {
    /**
     * 기능 권한 — REQ-PR-0015(사용자별 접근 기능 분리)의 **임시 체계**.
     *
     * 요구사항 명세서 §미결 9 「사용자 유형/권한/접근 범위 정의」가 고객 액션 대기라,
     * 확정 전까지 쓸 최소 골격이다. 워크플로우 문서의 실제 담당 주체(전산담당·생산관리자·
     * 품질담당·설비담당·물류담당)를 그대로 축으로 삼았다.
     *
     * **조회는 하나로 둔다.** 기준정보를 못 보게 막을 실익이 거의 없고, 나누면 담당자가
     * 남의 도메인 코드를 참조할 때마다 막힌다. 쓰기·비활성화만 도메인별로 나눈다.
     */
    groupCode: 'PERMISSION',
    groupName: '기능 권한',
    values: [
      { code: 'MASTER_READ', codeName: '기준정보 조회(전체)', order: 10 },

      { code: 'MASTER_PRODUCTION_WRITE', codeName: '생산 기준정보 등록·수정', order: 20 },
      { code: 'MASTER_PRODUCTION_DEACTIVATE', codeName: '생산 기준정보 비활성화', order: 21 },

      { code: 'MASTER_QUALITY_WRITE', codeName: '품질 기준정보 등록·수정', order: 30 },
      { code: 'MASTER_QUALITY_DEACTIVATE', codeName: '품질 기준정보 비활성화', order: 31 },

      { code: 'MASTER_EQUIPMENT_WRITE', codeName: '설비·금형 등록·수정', order: 40 },
      { code: 'MASTER_EQUIPMENT_DEACTIVATE', codeName: '설비·금형 비활성화', order: 41 },

      { code: 'MASTER_LOGISTICS_WRITE', codeName: '물류 기준정보 등록·수정', order: 50 },
      { code: 'MASTER_LOGISTICS_DEACTIVATE', codeName: '물류 기준정보 비활성화', order: 51 },

      { code: 'MASTER_ORGANIZATION_WRITE', codeName: '조직·인원 기준정보 등록·수정', order: 60 },
      { code: 'MASTER_ORGANIZATION_DEACTIVATE', codeName: '조직·인원 기준정보 비활성화', order: 61 },

      { code: 'MASTER_SYSTEM_WRITE', codeName: '시스템 설정 등록·수정', order: 70 },
      { code: 'MASTER_SYSTEM_DEACTIVATE', codeName: '시스템 설정 비활성화', order: 71 },

      { code: 'ACCESS_READ', codeName: '접근권한 조회', order: 80 },
      { code: 'ACCESS_WRITE', codeName: '접근권한 관리(단말 토큰 발급 포함)', order: 81 },
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
    // DDL 주석이 용도를 명시한다: 공정 수행 자격(FR-WO-009/022) · 검사자 자격(FR-QM-014)
    groupCode: 'QUALIFICATION_TYPE',
    groupName: '자격 유형',
    values: [
      { code: 'PROCESS_OPERATION', codeName: '공정 수행', order: 10 },
      { code: 'INSPECTOR', codeName: '검사자', order: 20 },
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
    groupCode: 'EQUIPMENT_TYPE',
    groupName: '설비 유형',
    values: [
      { code: 'MACHINE', codeName: '생산설비', order: 10 },
      { code: 'INSPECTION', codeName: '검사장비', order: 20 },
      { code: 'UTILITY', codeName: '유틸리티설비', order: 30 },
    ],
  },
  {
    // 개념모델 v2 §1 설비의 '신규입고/폐기 상태'를 축으로 삼았다.
    groupCode: 'EQUIPMENT_STATUS',
    groupName: '설비 상태',
    values: [
      { code: 'NEW', codeName: '신규입고', order: 10 },
      { code: 'NORMAL', codeName: '정상', order: 20 },
      { code: 'MAINTENANCE', codeName: '점검중', order: 30 },
      { code: 'BREAKDOWN', codeName: '고장', order: 40 },
      { code: 'DISPOSED', codeName: '폐기', order: 50 },
    ],
  },
  {
    // 확정된 축은 '외주공정 구분'(개념모델 v2 §1 공정) 하나뿐이라 그 축만 넣는다.
    // 사출/조립/검사 같은 공정 분류축이 필요하면 값을 추가하거나 별도 코드그룹으로 뺀다.
    groupCode: 'PROCESS_TYPE',
    groupName: '공정 유형',
    values: [
      { code: 'INTERNAL', codeName: '자체공정', order: 10 },
      { code: 'OUTSOURCED', codeName: '외주공정', order: 20 },
    ],
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
    groupCode: 'LOCATION_TYPE',
    groupName: '로케이션 유형',
    values: [
      { code: 'ZONE', codeName: '구역', order: 10 },
      { code: 'RACK', codeName: '랙', order: 20 },
      { code: 'CELL', codeName: '셀', order: 30 },
      { code: 'DOCK', codeName: '입하장', order: 40 },
    ],
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
    groupCode: 'STORAGE_CONDITION',
    groupName: '보관조건',
    values: [
      { code: 'NORMAL', codeName: '상온', order: 10 },
      { code: 'COLD', codeName: '냉장', order: 20 },
      { code: 'FROZEN', codeName: '냉동', order: 30 },
      { code: 'HAZARD', codeName: '위험물', order: 40 },
    ],
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
     * ⚠ SEMI_FINISHED·MERCHANDISE는 영문 표기가 아직 확정 전이다. 계약 7벌에 창고유형
     *   영문 코드가 0건이고(한글로만 '자재·제품·반제품·상품·생산'), 설계 회신이 이 표기를
     *   쓴 근거는 #47 코멘트가 우리 시드를 SEMI·MDSE 대신 긴 이름으로 잘못 인용한 대목뿐이다.
     *   2026-09-01에 어느 쪽이 정본인지 물어 두었고, 답이 오기 전까지 설계 회신 표기를
     *   잠정으로 쓴다 — 바뀌면 여기와 mdm.warehouse.warehouse_type_code를 함께 고친다.
     */
    groupCode: 'WAREHOUSE_TYPE',
    groupName: '창고유형',
    values: [
      { code: 'MATERIAL', codeName: '자재창고', order: 10 },
      { code: 'SEMI_FINISHED', codeName: '반제품창고', order: 20 },
      { code: 'PRODUCT', codeName: '제품창고', order: 30 },
      { code: 'MERCHANDISE', codeName: '상품창고', order: 40 },
      { code: 'PRODUCTION', codeName: '생산창고', order: 50 },
      { code: 'SPARE_PART', codeName: '예비품창고', order: 60 },
    ],
    retired: ['SEMI', 'MDSE', 'DEFECT', 'REWORK'],
  },
  {
    // BOM·Routing·검사기준은 개정(Rev) 단위로 살아 있다 — 상태축이 곧 개정 수명주기다.
    groupCode: 'REVISION_STATUS',
    groupName: '개정 상태',
    values: [
      { code: 'DRAFT', codeName: '작성중', order: 10 },
      { code: 'ACTIVE', codeName: '적용중', order: 20 },
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
    // PQC 초중종·자주검사는 '주기' 축이다 — 검사유형(INSPECTION_TYPE)과 섞지 않는다.
    groupCode: 'INSPECTION_FREQUENCY',
    groupName: '검사 주기',
    values: [
      { code: 'EVERY_LOT', codeName: 'LOT 단위', order: 10 },
      { code: 'FIRST_MIDDLE_LAST', codeName: '초·중·종물', order: 20 },
      { code: 'SELF', codeName: '자주검사', order: 30 },
      { code: 'PERIODIC', codeName: '주기(시간·수량)', order: 40 },
    ],
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
      { code: 'BLOCKED', codeName: '진행불가', order: 80 },
      { code: 'CANCELLED', codeName: '취소', order: 90 },
    ],
    retired: ['HOLD'],
  },
  {
    // work_session.status_code — 한 작업지시를 실제로 돌린 구간. 비가동(02-S-H)이
    // 미정 골격이라 PAUSED의 사유코드 체계는 그쪽에서 확정한다.
    groupCode: 'WORK_SESSION_STATUS',
    groupName: '작업세션 상태',
    values: [
      { code: 'OPEN', codeName: '작업중', order: 10 },
      { code: 'PAUSED', codeName: '일시중지', order: 20 },
      { code: 'CLOSED', codeName: '종료', order: 30 },
    ],
  },
  {
    // work_session_event.event_type_code — 세션에 일어난 일의 시각 기록.
    //
    // 잠근다. 값에 따라 세션 상태·사유 필수 여부·사유 목록이 갈리므로 고객이 값을 더하면
    // 화면이 무엇을 해야 할지 정의되지 않는다(#62 — 이 플래그가 필요한 첫 그룹).
    groupCode: 'WORK_SESSION_EVENT_TYPE',
    groupName: '작업세션 이벤트 유형',
    isSystemOwned: true,
    values: [
      { code: 'START', codeName: '작업 시작', order: 10 },
      { code: 'PAUSE', codeName: '일시중지', order: 20 },
      { code: 'RESUME', codeName: '재개', order: 30 },
      { code: 'END', codeName: '작업 종료', order: 40 },
    ],
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
];

/**
 * 기본 채번규칙 — 공장을 가리지 않는 전역 규칙(plant_id=null)이다.
 *
 * 공장별로 다른 번호 체계가 필요해지면 관리 화면에서 공장 지정 규칙을 더한다.
 * 발번기가 「지정된 축이 많을수록 이긴다」로 고르므로 전역 규칙은 그대로 둬도 된다.
 */
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
const ROLES = [
  {
    code: 'SYSTEM_ADMIN',
    name: '시스템 관리자(전산담당)',
    permissions: [
      'MASTER_READ',
      'MASTER_PRODUCTION_WRITE',
      'MASTER_PRODUCTION_DEACTIVATE',
      'MASTER_QUALITY_WRITE',
      'MASTER_QUALITY_DEACTIVATE',
      'MASTER_EQUIPMENT_WRITE',
      'MASTER_EQUIPMENT_DEACTIVATE',
      'MASTER_LOGISTICS_WRITE',
      'MASTER_LOGISTICS_DEACTIVATE',
      'MASTER_ORGANIZATION_WRITE',
      'MASTER_ORGANIZATION_DEACTIVATE',
      'MASTER_SYSTEM_WRITE',
      'MASTER_SYSTEM_DEACTIVATE',
      'ACCESS_READ',
      'ACCESS_WRITE',
    ],
  },
  {
    code: 'PRODUCTION_MANAGER',
    name: '생산관리자',
    permissions: ['MASTER_READ', 'MASTER_PRODUCTION_WRITE', 'MASTER_PRODUCTION_DEACTIVATE'],
  },
  {
    code: 'QUALITY_MANAGER',
    name: '품질담당',
    permissions: ['MASTER_READ', 'MASTER_QUALITY_WRITE', 'MASTER_QUALITY_DEACTIVATE'],
  },
  {
    code: 'EQUIPMENT_MANAGER',
    name: '설비담당',
    permissions: ['MASTER_READ', 'MASTER_EQUIPMENT_WRITE', 'MASTER_EQUIPMENT_DEACTIVATE'],
  },
  {
    code: 'LOGISTICS_MANAGER',
    name: '물류담당',
    permissions: ['MASTER_READ', 'MASTER_LOGISTICS_WRITE', 'MASTER_LOGISTICS_DEACTIVATE'],
  },
  { code: 'VIEWER', name: '조회 전용', permissions: ['MASTER_READ'] },
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

  await seedNumberingRules();
  await seedRoles();
  await seedAdmin();
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
    await prisma.role_permission.deleteMany({
      where: { role_id: saved.role_id, permission_code: { notIn: role.permissions } },
    });

    // eslint-disable-next-line no-console
    console.log(`seeded role ${role.code} (${role.permissions.length} permissions)`);
  }
}

async function seedAdmin(): Promise<void> {
  const LOGIN_ID = 'admin';
  const existing = await prisma.app_user.findUnique({
    where: { login_id: LOGIN_ID },
    include: { user_credential: true },
  });
  if (existing?.user_credential) {
    // eslint-disable-next-line no-console
    console.log('admin 계정·자격증명이 이미 있어 건너뜀');
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

  const admin =
    existing ??
    (await prisma.app_user.create({
      data: { login_id: LOGIN_ID, user_name: '시스템 관리자', status_code: 'ACTIVE' },
    }));

  await prisma.user_credential.create({
    data: { app_user_id: admin.app_user_id, password_hash: hash, must_change_password: true },
  });

  const adminRole = await prisma.role.findUniqueOrThrow({ where: { role_code: 'SYSTEM_ADMIN' } });
  await prisma.user_role.upsert({
    where: { app_user_id_role_id: { app_user_id: admin.app_user_id, role_id: adminRole.role_id } },
    update: {},
    create: { app_user_id: admin.app_user_id, role_id: adminRole.role_id },
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
