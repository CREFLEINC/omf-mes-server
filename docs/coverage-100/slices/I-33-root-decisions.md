# I-33 root 통합 결정 — 2026-09-07

정본 출판 시점: main #310 4cfe9a9 직접355/487·DB56, I31계획#309도병합됨. 아래 d5979ca/353/#308미병합은 **결정 당시의 역사**다. 수정계획808줄root전건재독·117~119문의정본화 완료, I33source/DDL0. I32순간helper R15 위치는maintenance-instant로후속조율/구현중이며아직병합아니다.

root가 초안756줄과 독립 API75/UIUX85/통합보고서 전부를 직접 읽고 아래를 결정했다. 코드/DDL 승인 전 정본 계획PR 필수. 현재 main d5979ca 공식353, I30②#308은 B DB56에 적용했지만독립리뷰중·미병합. 과거I33DB54 관측/후속55통지와구분한다. 소스구현0이며3관점문서완료가API완료아님.

## 0-재수립 R표

| R | 안건 | API | UIUX | 통합 | root 결정 |
|---|---|---|---|---|---|
| R1 | 툴추가4/완화2·입력권한 | 채택/A2단계정정 | 채택 | 채택/0단계 | A20 nullable4+옛NN2완화·과거required500/환경배포검사. 제출shotCount는고정P0501의화면증분권한·required입력을0단계로보존. 환산근거numeric20,6·DIRECT짝검증유지,현재정책/cavity/곱반올림/엄격곱일치추가0. 문의119. |
| R2 | 누계·잠금·version | 동일tx지지 | I31future구별 | M1강도수정 | mold FOR NO KEY UPDATE→현재누계가산/version/updated_by·updated_at기준시각동일tx. 비키가산이라FK KEY SHARE호환,production W/O→moldFK역대기해소. 기존writer수정0/새W/O상태배정검사0. 아래실제writer회귀필수. |
| R3 | 검교정 결과 의미 | 기본3채택 | 기본3채택 | 기본3채택 | seed PASS=적합/ADJUSTED=조정후적합/FAIL=부적합과고정합격계열효과의0단계연결을채택. CAL PASS/ADJUSTED는이력+master2날짜/version동일tx,FAIL이력만. runtime이름분류0. 확장CAL미분류만422STATE_LOCKED·전건0(최초①후②),nonCAL유효확장정상201. 문의117. |
| R4 | 검교정추가8·유일성·V | 채택 | 채택 | 채택 | A22추가8(차단false계약default포함)·기존sameequip/date제약을유형포함partial+legacyNULLpartial로완화. 컬럼/표삭제0. version/updated_at새칸0:clear는rowlock·token미선언,보고서표현V추가계획철회이지기존컬럼삭제아님. |
| R5 | 채널물리·NULL유일 | 채택 | 채택/U1 | 채택 | A21nullable5+옛NN3완화,key100/code50복사0,구uq유지+新四축NULL식unique(비트+COALESCE0)·inactive도점유. item/process 독립조건공존·inspectionItem차이만으로중복허용0. 새유일위반만tx바깥정확index명409로번역. |
| R6 | T원천·flag·필터·무페이지 | A1분리수정 | T승인/소비자구별 | M2분리수정 | T=설비/key별실제관측최신snapshot저장소라는기존통합권고채택. storedobservedAt/lastValue같은행그대로조회,수집기/추출/시계대체/동률선택0. registered EXISTS flag와unmappedOnly NOT EXISTS(active && item_spec FK nonnull)분리. 무page/age/limit·items+totalCount전체,同key설비별독립. 문의118. |
| R7 | 최신Rev·조인·구행 | 채택 | 채택 | 채택 | 同plan MAX(plan_version)상태무관·새DRAFT포함,생산적용/확정판정아님. oldRev/단위불일치/NULL연결저장허용·경고18필드조인,ref손상500/실제NULL구별. 과거필수NULL/구writer환경활성화유보·가짜backfill/NULL→예시0. |
| R8 | actor/worker/tx/오류 | 유지 | 유지 | 유지 | run실제tx·actor+원문body/path/method·툴POST만rawworker지문,존재검사신규tx/형식재생전,staleIfMatch재생유지. 403선언4개만,GET/clear추가0,clear버전/ETag0. I30localcontext실제병합뒤재사용. 091/093/096/109연계. |
| R9 | 단위 없는 채널 PUT | 지적없음 | U1채택 | 지적없음 | unitCode=''은미정가장자리②400INVALID field unitCode·CHANNEL_EMPTY_UNIT_POLICY='REJECT_EMPTY'. 없는단위유지는unitCode생략PUT으로정상,이미있는단위의해제는명시원천없으므로별도 단건 문의 번호는 추가 대역 승인 후 배정. client매번빈string전송결함에맞춰server''→NULL대체0. signalName빈원문과unitFK다름. |
| R10 | 가져오기 성공/실패 | flag분리 | U2채택 | flag분리 | 실제client reasonOf409/500→NULL→summarize성공계수하는결함. 서버중복409유지,별도consumer실패outcome/사유없음표시·부분성공합계인수미완. HTTP실패를400DUPLICATE로변형0. 별도 단건 문의 번호는 추가 대역 승인 후 배정. |
| R11 | 검교정 소비자·날짜 | 기본label불변 | U3/U4채택 | 코드이름변경효과불변 | registry ADJUSTED/EXTERNAL선택·비대상기기CHECK경고후등록·ADJUSTED미리보기·기한NULL≠이력없음·공장오늘/UTC표시·clear실제UI미완인수. API기본/nonCAL정상유지. 117/094. 서버cycle/MAX/브라우저TZ날짜보정0. |
| R12 | FK참조·삭제경합 | 기존안 | 기존안 | N1채택 | equipment/process실제REFERRERS추가·itemERP원본잠금/referenceCountNULL유지. quality item_spec삭제보호는A사전조율후:measurement기존검사+channel참조·사전검사뒤경합의정확한新FK P2003를tx밖400STATE_LOCKED로번역. PLAN_VERSION직접FK가짜추가0. |
| R13 | I31reset/µs인수 | 미래접점 | 미래접점 | N2조건화 | I31 R2 resettrue거부/normalnonreset유지,미승인성공시나리오조건부. 지금두증분/MDMCAS·reset거부무증분으로검증. 실제reset재개뒤교차회귀연결. I32canonicalR2/R14µs helper단일재사용(아직미구현)·server발생시각보완0. |
| R14 | 절차·PR·현재성 | A3정정 | U5정정 | N2정정 | 옛3조건삭제·기본3관점/5축. 10조각은상한별구현후보이며최소개수보증0. 일반350/400,core전체200,물리3영역/M2T분할은실제diff·A조율에따라. 문의117/118/119root예약. 단위 해제·import 실패집계는별도단건이므로추가대역승인전미배정,서로무관한물음을118에몰아넣지않음. |

## R2 잠금 근거와 실제 회귀

root는 work-session.service.ts54,69~75(W/O FOR UPDATE→moldFKINSERT),work-order-write.service.ts174,189,212(W/O잠금→planned_mold FKUPDATE)실물을직접읽었다. O3의 mold FOR UPDATE→tool_usage의W/O FK는역순대기가가능하다. NO KEY UPDATE는비키누계/version writer끼리직렬화하면서production FK의KEY SHARE를허용한다([PostgreSQL16공식Table13.3](https://www.postgresql.org/docs/16/explicit-locking.html#LOCKING-ROWS)). TOOL_USAGE_REFERENCE_LOCK_COMPATIBILITY 이름과실제2connection/barrier회귀2건으로검증한다. 코드분석이지이미재현한PASS가아니다. work_order선잠금추가대안은비선택(강도완화만으로고리를끊고새검증축없음).

## R6 원천 권위·필터의 결정 경계

root가고정계약O6:2630~2699/Observation:4963~4988와W0507§5-2~5-4를직접대조했다. ‘연결없음’은등록행NULL/비활성과별개며,상태·항목연결의존재를읽는필터를뜻한다. registeredExists=同equipment/key어떤등록행,hasActiveLink=同equipment/key의active+item_spec연결행. 따라서등록미연결또는비활성만있는경우unmappedOnly=true에도남고alreadyMapped=true라중복import선택만차단한다. 활성조건A연결+조건B미연결이섞이면hasActiveLink=true라미매핑필터에서는제외;이는ANY연결의존재이지현재생산조건의적용가능성을가정한것이아니며문의118에예제명시. 실제생산품목/공정은O6질의에없어도출0.

T source는구통합계획의명시신설권고를구체화한실제테이블로확정한다. 조회API는그곳에저장된 **관측시각과값**을함께원문정밀도로읽고현재시각/로그전송시각으로대체하지않는다. 이API는observed_at을선택하거나수신기writer를구현하지않으므로발생vs수신/동률tie/역순메시지문제는**writer운영인수**에남긴다. integration보고서의‘해소못하면O6유보’는수집통합활성화의조건으로반영하되,이미지정한T에실재값이있을때읽는DB조회전체를보류하지않는다. 단영구빈stub는금지:NULL값/동일키다중설비/원문시각/flag혼합/필터count전부typedDBfixture로읽어검증. 수집자가없어빈T인현장에import실사용완료를보고하지않는다. schema/DBAPI/수집자/UI의네완료단계를분리한다.

## 편집 인계

R표기존8을위14로채우고해당본문/SQL주석/테스트/PR/마감표를일치시킨다. 전필드/물리SQL은확정범위밖축약0. 시각정책은I32 R14직접링크/helper미구현과계획만병합을구별. 캘리브레이션blocksfalse신규default는명시계약default이므로다른새필수NULL무보완과모순없음. 문의117검교정의미/소비자,118최근관측원천·미매핑 의미,119툴증분/환산/누계귀속root예약. 기존091구행/093헤더오류/094공장TZ/096tx/109µs재사용. 원래선행SQL후보·DB측정과새결정은문서에서사실/권고/미실행을구분한다.
