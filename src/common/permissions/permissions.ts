/**
 * 기능 권한 목록 — 계약 `mdm-기준정보.json` `GET /app/permissions` 의 응답 원본.
 *
 * ⛔ **표가 아니라 앱 상수다.** 근거 넷이 같은 방향을 가리킨다.
 *   1. 계약 `Permission` 스키마에만 `x-source-table` 이 없다 — `Role`·`RolePermission` 에는 있다.
 *   2. `app.role_permission.permission_code` 에 FK 가 없다(FK 는 `role_id` 하나뿐).
 *   3. 계약 설명 — 「앱이 소유한다. 화면이 늘면 배포로 는다. 고객이 만들거나 지우지 않는다」.
 *   4. `GET /app/permissions` 에 파라미터도 페이징도 없다 — 화면 수만큼으로 닫힌 고정 목록이다.
 *
 * ⛔ 손으로 고치지 않는다. 설계 저장소 `design/schema/generators/권한목록.md` 에서 옮긴다 —
 * 그쪽도 `build-permission-catalog.py` 가 화면 목록에서 기계 파생한 생성물이다.
 * 화면이 늘면 그 생성기를 다시 돌린 결과를 여기로 옮긴다.
 *
 * 입도 = 화면 단위(설계 사용자 결정 2026-09-01). 한 화면 안에서 조회와 편집을 가르지 않는다.
 * 출처 실측: 2026-09-02 · 권한 117 · 도메인 축 7
 */

/** 계약 `#/components/schemas/Permission` 과 동형. */
export interface Permission {
  /** `role_permission.permission_code` 에 그대로 들어간다. 화면 코드와 1:1 이다. */
  code: string;
  /** 격자 열 머리에 보일 이름. 화면이 지어내지 않고 서버가 준 것을 그대로 쓴다. */
  name: string;
  /** 격자를 묶는 도메인 축. 117 열을 묶지 않으면 관리자가 옆으로 끝없이 스크롤한다. */
  groupCode: string;
}

/**
 * 입하~출고 추적 화면(설계 밖 · 장부 P-119). ⚠ 번호와 메뉴 자리는 화면 계획이 정해지면 확정한다 — 그때 이 값과
 * `prisma/seed.ts` 관리자 역할 목록의 같은 문자열만 바꾼다.
 */
export const TRACE_FLOW_SCREEN = 'W-01-14';

export const PERMISSIONS: readonly Permission[] = [
  // 01 자재·창고
  { code: 'M-01-01', name: '입하 등록', groupCode: '01' },
  { code: 'M-01-02', name: '자재LOT 번호 스캔·등록 (발번)', groupCode: '01' },
  { code: 'M-01-04', name: '자재 위치 확인', groupCode: '01' },
  { code: 'M-01-05', name: '적치·입고 완료', groupCode: '01' },
  { code: 'M-01-06', name: '입하 오류 등록', groupCode: '01' },
  { code: 'M-01-07', name: '임시 위치 적재', groupCode: '01' },
  { code: 'M-01-08', name: '자재 출고·피킹', groupCode: '01' },
  { code: 'M-01-09', name: '생산창고 입고·호퍼 잔량 입력', groupCode: '01' },
  { code: 'M-01-10', name: '재고이동·불량 반출', groupCode: '01' },
  { code: 'M-01-11', name: '실물 카운트', groupCode: '01' },
  { code: 'M-01-12', name: '재생재 등록', groupCode: '01' },
  { code: 'M-01-13', name: '긴급 IQC 생략 요청', groupCode: '01' },
  { code: 'P-01-01', name: '자재LOT 등록·라벨 발행', groupCode: '01' },
  { code: 'P-01-02', name: '출고 QR 발행', groupCode: '01' },
  { code: 'W-01-01', name: 'IQC 수입검사·판정', groupCode: '01' },
  { code: 'W-01-02', name: '긴급 IQC 생략 한도승인', groupCode: '01' },
  { code: 'W-01-03', name: '초과 입하 분리', groupCode: '01' },
  { code: 'W-01-04', name: '재고실사', groupCode: '01' },
  { code: 'W-01-05', name: '공급사 반품 처리', groupCode: '01' },
  { code: 'W-01-06', name: '폐기 요청·기타출고', groupCode: '01' },
  { code: 'W-01-07', name: '재고 현황·상태 조회(위치별 분포 포함)', groupCode: '01' },
  { code: 'W-01-09', name: '입하 예정 조회', groupCode: '01' },
  { code: 'W-01-10', name: '정상품 입하 처리 (입고 확정·Release·G/R 송신)', groupCode: '01' },
  { code: 'W-01-11', name: '신규 P/O 등록', groupCode: '01' },
  { code: 'W-01-12', name: '재고조정', groupCode: '01' },
  { code: 'W-01-13', name: '물류 문서 진행현황·취소', groupCode: '01' },
  { code: TRACE_FLOW_SCREEN, name: '입하~출고 추적', groupCode: '01' },
  // 02 생산 실행
  { code: 'M-02-01', name: 'WIP 공정 이동 스캔', groupCode: '02' },
  { code: 'M-02-02', name: '수리 왕복 투입·반출 스캔', groupCode: '02' },
  { code: 'P-02-01', name: '작업 시작 (MES W/O 선택)', groupCode: '02' },
  { code: 'P-02-02', name: '작업 전 점검 이력 확인·통제', groupCode: '02' },
  { code: 'P-02-03', name: '자재 투입 스캔·오투입 검증', groupCode: '02' },
  { code: 'P-02-04', name: '작업실적 등록 (LOT·제품 선택)', groupCode: '02' },
  { code: 'P-02-05', name: '인식표 발행·부착', groupCode: '02' },
  { code: 'P-02-06', name: '생산LOT 완료 처리', groupCode: '02' },
  { code: 'P-02-07', name: 'LOT 라벨 출력·부착', groupCode: '02' },
  { code: 'P-02-08', name: '포장 작업 (LOT 스캔·제품 포장)', groupCode: '02' },
  { code: 'P-02-09', name: '포장 라벨·인식표 재출력·부착', groupCode: '02' },
  { code: 'P-02-10', name: '작업 중단(홀드) 등록', groupCode: '02' },
  { code: 'P-02-11', name: '러닝체인지 부품 교체 등록', groupCode: '02' },
  { code: 'P-02-12', name: '긴급 W/O 현장 투입·실적', groupCode: '02' },
  { code: 'P-02-13', name: 'PQC 제품 검사·검사 결과 입력', groupCode: '02' },
  // ⚠ 생성기 산출물이 아니다 — 설계 밖 POP 화면이라 손으로 넣었다(사용자 결정 · 장부 P-52).
  { code: 'P-02-14', name: '자재 불량 등록', groupCode: '02' },
  // ⚠ 생성기 산출물이 아니다 — 설계 밖 POP 화면이라 손으로 넣었다(omf-all-around#89 · 장부 P-102).
  { code: 'P-02-15', name: '제품 검사표 입력', groupCode: '02' },
  { code: 'W-02-01', name: 'ERP W/O 수신·조회', groupCode: '02' },
  { code: 'W-02-02', name: 'W/O 전개·편성', groupCode: '02' },
  { code: 'W-02-03', name: '4M 자원배정·유효성 점검', groupCode: '02' },
  { code: 'W-02-04', name: 'W/O 확정·배포·생산LOT 선발행', groupCode: '02' },
  { code: 'W-02-05', name: 'W/O 마감·ERP 실적 송신', groupCode: '02' },
  { code: 'W-02-06', name: 'ERP W/O 변경 관리자 확인', groupCode: '02' },
  { code: 'W-02-07', name: '긴급 W/O 발행', groupCode: '02' },
  { code: 'W-02-08', name: 'W/O 진행현황 조회(생산 실적 집계 포함)', groupCode: '02' },
  { code: 'W-02-10', name: '추가 자재 출고 요청(수동)', groupCode: '02' },
  // 03 품질
  { code: 'W-03-01', name: 'Lot Status 현황·변경이력 조회', groupCode: '03' },
  { code: 'W-03-02', name: 'Lot Status 판정·전이 처리', groupCode: '03' },
  { code: 'W-03-03', name: '의심자재 등록', groupCode: '03' },
  { code: 'W-03-05', name: '검사실적·검사결과 조회 (불량률·불량코드 분포 집계 포함)', groupCode: '03' },
  { code: 'W-03-09', name: '특채·한도승인 승인 처리', groupCode: '03' },
  { code: 'W-03-10', name: '처분 판정 처리(재작업/폐기/정상)', groupCode: '03' },
  // ⚠ 생성기 산출물이 아니다 — 설계 밖 관리웹 화면이라 손으로 넣었다(사용자 결정 · 장부 P-51).
  { code: 'W-03-11', name: 'PQC 검사 등록·조회', groupCode: '03' },
  // ⚠ 생성기 산출물이 아니다 — 설계 밖 관리웹 화면이라 손으로 넣었다(omf-all-around#64 · 장부 P-87).
  { code: 'W-03-12', name: '검사 수준 관리', groupCode: '03' },
  // ⚠ 생성기 산출물이 아니다 — 설계 밖 관리웹 화면이라 손으로 넣었다(omf-all-around#89 · 장부 P-102).
  { code: 'W-03-13', name: '제품 검사표 조회·출력', groupCode: '03' },
  // ⚠ 생성기 산출물이 아니다 — 같은 조회 화면의 서명·승인 권한을 따로 둔다(omf-all-around#89 · 장부 P-102 · 담당자 결정 ③).
  { code: 'W-03-14', name: '제품 검사표 서명·승인', groupCode: '03' },
  // 04 제품 출하
  { code: 'M-04-01', name: '제품LOT 피킹 스캔', groupCode: '04' },
  { code: 'M-04-03', name: '포장 재구성 스캔', groupCode: '04' },
  { code: 'M-04-04', name: '제품입고·적치', groupCode: '04' },
  { code: 'P-04-01', name: 'Packing(P&P) 실적 등록', groupCode: '04' },
  { code: 'P-04-02', name: '납품·포장 라벨 출력', groupCode: '04' },
  { code: 'P-04-03', name: '재작업 실적 등록', groupCode: '04' },
  { code: 'P-04-04', name: '재구성 신규 라벨 발행', groupCode: '04' },
  { code: 'P-04-05', name: '출하 단위 구성', groupCode: '04' },
  // ⚠ 생성기 산출물이 아니다 — 설계 밖 POP 화면이라 손으로 넣었다(사용자 결정 · 장부 P-80).
  { code: 'P-04-06', name: 'OQC 출하검사 판정', groupCode: '04' },
  { code: 'W-04-01', name: '출하지시서 Import·작업지시 생성', groupCode: '04' },
  { code: 'W-04-02', name: '출하 예정 목록', groupCode: '04' },
  { code: 'W-04-03', name: 'OQC 출하검사 판정', groupCode: '04' },
  { code: 'W-04-04', name: '출하 처리(상차·실물 출고)', groupCode: '04' },
  { code: 'W-04-05', name: '긴급 직행 출하 처리', groupCode: '04' },
  { code: 'W-04-06', name: '반품·클레임 입고 등록', groupCode: '04' },
  { code: 'W-04-07', name: '재작업/폐기 판정 의뢰', groupCode: '04' },
  { code: 'W-04-08', name: '완제품 재고·Lot Status 조회', groupCode: '04' },
  { code: 'W-04-10', name: '제품 폐기 요청', groupCode: '04' },
  { code: 'W-04-11', name: '재고 재등록', groupCode: '04' },
  { code: 'W-04-12', name: '출하 확정·취소', groupCode: '04' },
  // 05 설비·툴
  { code: 'M-05-01', name: '설비 점검 입력', groupCode: '05' },
  { code: 'M-05-02', name: '설비 고장 현장 보고', groupCode: '05' },
  { code: 'P-05-01', name: '툴 사용실적 입력 (타발수)', groupCode: '05' },
  { code: 'P-05-02', name: '비가동 실적 입력', groupCode: '05' },
  { code: 'W-05-01', name: '타발수 환산 파라미터 설정', groupCode: '05' },
  { code: 'W-05-02', name: '툴 보전오더 생성 (PM 도래 조회)', groupCode: '05' },
  { code: 'W-05-03', name: '툴 PM 실적 등록', groupCode: '05' },
  { code: 'W-05-04', name: '설비 고장 상세·처리', groupCode: '05' },
  { code: 'W-05-05', name: '보전 지시 발행', groupCode: '05' },
  { code: 'W-05-06', name: '보전 실적·예비품 출고 등록', groupCode: '05' },
  { code: 'W-05-07', name: '수집채널 매핑 관리', groupCode: '05' },
  { code: 'W-05-08', name: '비가동 집계·조회', groupCode: '05' },
  { code: 'W-05-09', name: '작업 캘린더(WorkCalendar) 설정', groupCode: '05' },
  { code: 'W-05-10', name: '계측기 검교정 이력 등록', groupCode: '05' },
  { code: 'W-05-11', name: '계측기 마스터 관리', groupCode: '05' },
  { code: 'W-05-12', name: '설비·설비그룹 마스터', groupCode: '05' },
  { code: 'W-05-13', name: '툴/금형/지그 마스터', groupCode: '05' },
  // 06 기준정보
  // ⚠ 생성기 산출물이 아니다 — P-06-01(창고 적재 위치 라벨 발행)은 설계 화면 목록에 없는
  //   클라이언트 화면이라 손으로 넣었다(사용자 지시 · 장부 P-28). 설계가 등재하면 생성기
  //   결과로 바꿔 옮긴다.
  { code: 'P-06-01', name: '창고 적재 위치 라벨 발행', groupCode: '06' },
  { code: 'W-06-01', name: 'Routing(공정) 등록·관리', groupCode: '06' },
  { code: 'W-06-02', name: '검사기준 등록 (IQC/PQC/OQC) — **검사정책 포함**', groupCode: '06' },
  { code: 'W-06-03', name: '불량·원인코드 2계층 마스터', groupCode: '06' },
  { code: 'W-06-04', name: '판정유형 코드 마스터', groupCode: '06' },
  { code: 'W-06-05', name: '수신본 확장속성 편집 (품목·BOM)', groupCode: '06' },
  { code: 'W-06-06', name: '공통코드·조직·작업자 마스터 (다국어)', groupCode: '06' },
  { code: 'W-06-07', name: '창고·Location 마스터', groupCode: '06' },
  { code: 'W-06-08', name: '예비품 마스터', groupCode: '06' },
  { code: 'W-06-09', name: 'ERP-MES I/F 연계정의 관리', groupCode: '06' },
  { code: 'W-06-10', name: '연계 동기화 현황·실패 재처리', groupCode: '06' },
  { code: 'W-06-11', name: '마스터 변경관리 (신규 Rev 발행)', groupCode: '06' },
  { code: 'W-06-12', name: 'MES→ERP 송신 I/F 정의 (항목 on/off)', groupCode: '06' },
  { code: 'W-06-14', name: '적치 규칙 마스터', groupCode: '06' },
  { code: 'W-06-15', name: '결재선 정의', groupCode: '06' },
  { code: 'W-06-16', name: '사원정보 조회(ERP)', groupCode: '06' },
  { code: 'W-06-17', name: '품목정보 조회(ERP)', groupCode: '06' },
  { code: 'W-06-18', name: 'BOM 조회(ERP)', groupCode: '06' },
  { code: 'W-06-19', name: '거래처 조회(ERP)', groupCode: '06' },
  { code: 'W-06-20', name: '공통코드 조회(ERP)', groupCode: '06' },
  { code: 'W-06-21', name: '구매발주 조회(ERP)', groupCode: '06' },
  { code: 'W-06-22', name: '수주정보 조회(ERP)', groupCode: '06' },
  { code: 'W-06-23', name: 'ERP W/O 조회(ERP)', groupCode: '06' },
  // ⚠ 생성기 산출물이 아니다 — 설계 밖 관리웹 화면이라 손으로 넣었다(omf-all-around#89 · 장부 P-102).
  { code: 'W-06-24', name: '검사표 기준', groupCode: '06' },
  // CO 공통
  { code: 'M-CO-01', name: '기기 등록·사번 인증', groupCode: 'CO' },
  { code: 'P-CO-01', name: '사번 경량 인증', groupCode: 'CO' },
  { code: 'W-CO-01', name: '계정 로그인', groupCode: 'CO' },
  { code: 'W-CO-02', name: '사용자·역할·권한 관리', groupCode: 'CO' },
  { code: 'W-CO-03', name: '알림센터', groupCode: 'CO' },
  { code: 'W-CO-04', name: '공지·전달 게시/조회', groupCode: 'CO' },
  { code: 'W-CO-05', name: '통합 대시보드(경영·생산)', groupCode: 'CO' },
  { code: 'W-CO-06', name: '단말기-공정 매핑 설정', groupCode: 'CO' },
  { code: 'W-CO-08', name: '창고 적재 위치 배치도', groupCode: 'CO' },
  { code: 'W-CO-09', name: '결재함(승인 요청 목록)', groupCode: 'CO' },
  { code: 'W-CO-10', name: '비밀번호 변경', groupCode: 'CO' },
  { code: 'W-CO-11', name: '알람 수신자 설정', groupCode: 'CO' },
  // 설계 저장소 생성본에 없는 화면 둘 — 피처 001 이벤트 알림(omf-all-around#160 · 장부 P-92). 시드가 관리자에게 준다.
  { code: 'W-CO-12', name: '알림 연결 설정', groupCode: 'CO' },
  { code: 'W-CO-13', name: '알림 발송 이력', groupCode: 'CO' },
];

/** 권한 부여 요청이 「없는 코드」를 담았는지 가르는 자리. 계약이 그 검사를 요구한다. */
export const PERMISSION_CODES: ReadonlySet<string> = new Set(PERMISSIONS.map((p) => p.code));
