# I-27 summary `targetIds` CSV 검증 프로브

## 결론

`GET /app/document-issues/summary`의 계약상 정상 직렬화인
`?targetTypeCode=LOT&targetIds=1,2`는 현재 전역 `ContractValidationGuard`에서 handler 전에
400으로 거부된다. 계약은 `targetIds`를 array + `style: form` + `explode: false`로 선언하지만,
검증기는 parameter의 `schema`만 Ajv에 넘기고 `style`/`explode` 역직렬화를 하지 않는다.
Ajv의 `coerceTypes: true`도 scalar string을 array로 만들지는 않는다.

반대로 검증기에 `targetIds: ['1', '2']`를 직접 주면 통과하며 같은 객체가
`targetIds: [1, 2]`로 변한다. 따라서 controller pipe/split은 늦고, 이 오퍼레이션만 대상으로
Express query를 guard 전에 array로 바꾸는 Nest route middleware가 기술적으로 가능한 최소 seam이다.
이번 조사에서는 source/계약/테스트 파일을 수정하지 않았고 DB·서버·E2E·전체 gate·network를 쓰지 않았다.

## 계약과 현재 실행 경로

| 사실 | 근거 |
|---|---|
| `targetIds`는 필수 array, 1~1000 integer(int64) | `contracts/app-공통.json:1534-1545` |
| 직렬화는 `style: form`, `explode: false` | `contracts/app-공통.json:1546-1547` |
| 빈 값/상한 초과는 400 | `contracts/app-공통.json:1590-1599` |
| validator의 `Parameter` 타입은 `name/in/required/schema`만 보유 | `src/common/contract/contract-validator.ts:19-24` |
| query schema 조립은 parameter의 `schema` `$ref`만 사용 | `src/common/contract/contract-validator.ts:107-126` |
| query/path Ajv는 `coerceTypes: true`이나 array coercion 모드가 아님 | `src/common/contract/contract-validator.ts:194-201` |
| guard는 Express query 사본을 validator에 넘기고 오류면 즉시 400 | `src/common/contract/contract-validation.guard.ts:32-42` |
| guard는 pipe/interceptor보다 먼저 실행 | `src/common/contract/contract-validation.guard.ts:9-16` |
| 현재 전역 guard 순서 | `src/app.module.ts:26-37`: 인증 → 권한 → 계약 → 멱등 → 낙관적 잠금 |
| `configureApp`에는 prefix/filter/CORS만 있고 query 전처리나 global pipe는 없음 | `src/app.setup.ts:10-14` |
| `AppDomainModule`도 현재 middleware configure가 없는 평범한 module | `src/app/app-domain.module.ts:37-66` |

설치된 Express 5.2.1은 기본 query parser를 `simple`로 둔다
(`node_modules/.pnpm/express@5.2.1_supports-color@10.2.2/node_modules/express/lib/application.js:90-98`).
이 값은 `node:querystring.parse`로 연결된다
(`.../express/lib/utils.js:162-178`). `req.query`는 URL을 읽을 때마다 parser를 호출하는 getter다
(`.../express/lib/request.js:207-228`). 그래서 middleware에서 getter가 돌려준 임시 객체의 필드만
수정하면 다음 접근에서 사라질 수 있다. guard가 이미 쓰는 것처럼 query 사본을 만든 뒤
`Object.defineProperty(request, 'query', ...)`로 값 자체를 덮는 방식이 필요한 seam이다
(`src/common/contract/contract-validation.guard.ts:34-52`).

## 실측 1 — 원문 CSV와 미리 파싱한 배열

명령(기존 `ts-node` 10.9.2, in-memory `ContractValidator`, DB 없음):

```bash
node_modules/.bin/ts-node --transpile-only -e "const { ContractRegistry } = require('./src/common/contract/contract-registry'); const { ContractValidator } = require('./src/common/contract/contract-validator'); const key = 'GET /app/document-issues/summary'; const validator = new ContractValidator(ContractRegistry.load()); for (const [label, targetIds] of [['raw-csv', '1,2'], ['parsed-array', ['1','2']], ['single-csv', '1'], ['parsed-single-array', ['1']], ['empty-csv', ''], ['csv-empty-token', '1,'], ['parsed-empty-token', ['1','']], ['duplicate-csv', '2,1,2'], ['parsed-duplicate-array', ['2','1','2']]]) { const query = { targetTypeCode: 'LOT', targetIds }; const errors = validator.validate(key, { query }); console.log(JSON.stringify({ label, query, errors })); }"
```

종료코드: `0`

```text
{"label":"raw-csv","query":{"targetTypeCode":"LOT","targetIds":"1,2"},"errors":[{"scope":"field","field":"targetIds","code":"INVALID","message":"must be array"}]}
{"label":"parsed-array","query":{"targetTypeCode":"LOT","targetIds":[1,2]},"errors":[]}
{"label":"single-csv","query":{"targetTypeCode":"LOT","targetIds":"1"},"errors":[{"scope":"field","field":"targetIds","code":"INVALID","message":"must be array"}]}
{"label":"parsed-single-array","query":{"targetTypeCode":"LOT","targetIds":[1]},"errors":[]}
{"label":"empty-csv","query":{"targetTypeCode":"LOT","targetIds":""},"errors":[{"scope":"field","field":"targetIds","code":"INVALID","message":"must be array"}]}
{"label":"csv-empty-token","query":{"targetTypeCode":"LOT","targetIds":"1,"},"errors":[{"scope":"field","field":"targetIds","code":"INVALID","message":"must be array"}]}
{"label":"parsed-empty-token","query":{"targetTypeCode":"LOT","targetIds":[1,""]},"errors":[{"scope":"field","field":"targetIds[1]","code":"INVALID","message":"must be integer"}]}
{"label":"duplicate-csv","query":{"targetTypeCode":"LOT","targetIds":"2,1,2"},"errors":[{"scope":"field","field":"targetIds","code":"INVALID","message":"must be array"}]}
{"label":"parsed-duplicate-array","query":{"targetTypeCode":"LOT","targetIds":[2,1,2]},"errors":[]}
```

해석: canonical CSV는 단건이어도 array로 승격되지 않는다. 배열로만 만들어 주면 기존 validator가
각 원소를 integer로 검증·강제 변환한다. 계약에 `uniqueItems`가 없으므로 duplicate 배열은 현재
정상이며 순서와 multiplicity도 유지된다.

## 실측 2 — Express simple parser의 실제 형태

명령:

```bash
node -e "const querystring=require('node:querystring'); console.log(JSON.stringify({csv:querystring.parse('targetIds=1%2C2'), repeated:querystring.parse('targetIds=1&targetIds=2'), empty:querystring.parse('targetIds=')}))"
```

종료코드: `0`

```text
{"csv":{"targetIds":"1,2"},"repeated":{"targetIds":["1","2"]},"empty":{"targetIds":""}}
```

canonical `explode:false` CSV는 scalar가 되고, 비canonical repeated-key 표현은 배열이 된다. 현재
validator는 직렬화 style을 모르므로 전자는 거부하고 후자는 통과시키는 역전이 있다.

## 실측 3 — split 뒤 malformed/상한/duplicate 경계

이 실측은 구현안이 아니라 단순 `raw.split(',')` 결과를 기존 validator에 넣어 계약 schema의
경계를 확인한 것이다.

```bash
node_modules/.bin/ts-node --transpile-only -e "const { ContractRegistry } = require('./src/common/contract/contract-registry'); const { ContractValidator } = require('./src/common/contract/contract-validator'); const validator = new ContractValidator(ContractRegistry.load()); const key = 'GET /app/document-issues/summary'; const samples = [['csv-two','1,2'],['csv-one','1'],['empty',''],['leading-empty',',1'],['trailing-empty','1,'],['middle-empty','1,,2'],['duplicates','2,1,2'],['whitespace','1, 2'],['decimal','1,2.5']]; for (const [label, raw] of samples) { const targetIds = raw.split(','); const errors = validator.validate(key,{query:{targetTypeCode:'LOT',targetIds}}); console.log(JSON.stringify({label,raw,targetIds,errors})); } for (const count of [1000,1001]) { const targetIds = Array.from({length:count},(_,index)=>String(index+1)); const errors = validator.validate(key,{query:{targetTypeCode:'LOT',targetIds}}); console.log(JSON.stringify({label:'count-'+count,length:targetIds.length,first:targetIds[0],last:targetIds[targetIds.length-1],errorCodes:errors.map((error)=>({field:error.field,code:error.code,message:error.message}))})); }"
```

종료코드: `0`

```text
{"label":"csv-two","raw":"1,2","targetIds":[1,2],"errors":[]}
{"label":"csv-one","raw":"1","targetIds":[1],"errors":[]}
{"label":"empty","raw":"","targetIds":[""],"errors":[{"scope":"field","field":"targetIds[0]","code":"INVALID","message":"must be integer"}]}
{"label":"leading-empty","raw":",1","targetIds":["",1],"errors":[{"scope":"field","field":"targetIds[0]","code":"INVALID","message":"must be integer"}]}
{"label":"trailing-empty","raw":"1,","targetIds":[1,""],"errors":[{"scope":"field","field":"targetIds[1]","code":"INVALID","message":"must be integer"}]}
{"label":"middle-empty","raw":"1,,2","targetIds":[1,"",2],"errors":[{"scope":"field","field":"targetIds[1]","code":"INVALID","message":"must be integer"}]}
{"label":"duplicates","raw":"2,1,2","targetIds":[2,1,2],"errors":[]}
{"label":"whitespace","raw":"1, 2","targetIds":[1,2],"errors":[]}
{"label":"decimal","raw":"1,2.5","targetIds":[1,"2.5"],"errors":[{"scope":"field","field":"targetIds[1]","code":"INVALID","message":"must be integer"}]}
{"label":"count-1000","length":1000,"first":1,"last":1000,"errorCodes":[]}
{"label":"count-1001","length":1001,"first":1,"last":1001,"errorCodes":[{"field":"targetIds","code":"RANGE","message":"must NOT have more than 1000 items"}]}
```

## Route-local middleware seam

Nest 11의 공개 API는 module이 `NestModule.configure(consumer)`를 구현하고
`consumer.apply(middleware).forRoutes(string | controller | RouteInfo)`를 호출하는 형태다
(`@nestjs/common/.../nest-module.interface.d.ts:5-7`,
`middleware-consumer.interface.d.ts:10-17`, `middleware-config-proxy.interface.d.ts:7-23`).
`RouteInfo`는 `path`와 `RequestMethod`를 받는다
(`@nestjs/common/.../middleware-configuration.interface.d.ts:4-8`). 설치된 Nest는 middleware를
controller route 등록보다 먼저 등록한다
(`@nestjs/core/.../nest-application.js:117-121`). 또한 `forRoutes`의 non-wildcard path에 global
prefix를 자동으로 붙인다
(`@nestjs/core/.../middleware/route-info-path-extractor.js:57-69`).

따라서 구현자가 검토할 구체 seam은 다음과 같다. 이는 위치/API 조사 결과이며 구현 결정은 아니다.

- 소유 module: `src/app/app-domain.module.ts`의 `AppDomainModule`.
- route-local middleware 후보 파일: `src/app/document-issue/document-issue-summary-query.middleware.ts`
  (실제 document-issue 디렉터리 이름과 함께 확정).
- 등록 API 형태:
  `consumer.apply(DocumentIssueSummaryQueryMiddleware).forRoutes({ path: 'app/document-issues/summary', method: RequestMethod.GET })`.
  `api/` prefix는 `forRoutes` path에 넣지 않는다. Nest가 현재 global prefix를 붙인다.
- middleware는 response를 내거나 schema 검증을 하지 않고, `targetIds`가 scalar string인 경우에만
  CSV 토큰 배열로 바꾼 뒤 `req.query` 값 자체를 덮고 `next()`해야 한다. 그래야 인증보다 먼저 400을
  내 계약 모양을 노출하지 않고, 뒤의 인증 → 권한 → `ContractValidationGuard` 순서를 보존한다.
- controller의 `@Query()` pipe/split은 contract guard 뒤라 이 결손을 고칠 수 없다.
- `AppDomainModule`은 레인 공유 등록부다(`docs/coverage-100/lanes.md:74-85`). 실제 변경 시 자기
  middleware 등록만 추가하고 최신 main의 다른 레인 등록을 보존해야 한다.

## 아직 정책 판정이 필요한 경계

아래는 정규화 구현 전에 root 계획에서 명시해야 할 경계다. 이번 진단은 정책을 고르지 않는다.

1. 빈 CSV와 빈 token: `targetIds=`, `,1`, `1,`, `1,,2`를 필터링하면 malformed 입력이 정상으로
   바뀐다. 최소한 empty token을 조용히 제거해서는 안 되며, 정확한 400 field/code는 계획에서 정한다.
2. duplicate: `2,1,2`는 계약 schema상 허용된다(`uniqueItems` 없음). dedupe 여부를 임의로 바꾸지
   않는다. 현재 I-27 초안은 입력 순서와 multiplicity 보존을 제안하지만 최종 R 판정이 정본이다.
3. repeated/mixed syntax: Express는 `targetIds=1&targetIds=2`를 이미 배열로 만들고 현재 validator가
   허용한다. `targetIds=1,2&targetIds=3` 같은 혼합형을 거부할지 flatten할지는 계약 schema만으로
   정해지지 않는다. canonical `explode:false` 지원과 비canonical syntax 정책을 분리한다.
4. 상한은 split 뒤 원소 수로 센다. duplicate를 보존하면 duplicate도 개수에 포함되어 1000은 통과,
   1001은 RANGE다.
5. lexical integer 경계: 기존 Ajv coercion은 공백(`1, 2`)을 받아들이지만 decimal은 거부한다.
   부호·선행 0·unsafe int64의 전체 정책은 이 CSV seam에서 새로 정하지 않고 별도 기존 한계와 맞춘다.
6. key 부재는 middleware가 만들지 않고 validator의 required 판정에 맡긴다. scalar 단건 `targetIds=1`은
   `["1"]`로 만들어야 array minItems=1 정상 경로가 열린다.

## 작업 상태

- frozen contract SHA: `a6a87e144116ebaa32c01df5a12a0fd2924427e7`
- source/test/contract 수정: 0
- DB/server/network/E2E/full gates: 0
- 생성 파일: `.backend-dev/lane-b/I-27-csv-probe.md`만
