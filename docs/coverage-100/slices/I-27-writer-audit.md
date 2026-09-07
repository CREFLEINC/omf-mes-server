# I-27 POST source/writer audit — root evidence only

> Ownership: evidence note by the delegated writer-audit agent; every R decision, support-set change, implementation, test, and merge remains with the I-27 root.
> Snapshot: frozen contract `a6a87e1`; working source observed at HEAD `75d7bc5cfb06`; unmerged I-19 source heads are cited by full commit. Static read only: no DB/runtime/gate claim.
> Citation shorthand: `D` = `.design-reference/omf-mes/design/wiki`; paths beginning `screens/` or `api-contracts/` are below `D`; `...` repeats the immediately preceding file.

## 1. Contract floor

- `POST /app/document-issues` creates records and does not print; printer failure must not erase the record (`contracts/app-공통.json:1190-1196`). The request is one 1..1000-target transaction (`contracts/app-공통.json:4522-4526`).
- The 422 text combines missing reissue reason with “target is not issuable (bad judgment, etc.)” (`contracts/app-공통.json:1236-1243`). “Bad judgment” is an example, not a declared universal `lot.status_code = NORMAL` predicate.
- `targetTypeCode` is a closed seven-value set and `lotId` is nullable (`contracts/app-공통.json:4528-4564`). `document_issue_log.target_id` is polymorphic with no FK; only optional `lot_id` is a real LOT FK (`prisma/schema.prisma:183-200`).
- The output requirement fixes the five document mappings under review: material→LOT, GI QR→GI line, production→LOT, packing→packing, CoA→inspection result (`.design-reference/omf-mes/design/wiki/api-contracts/06-API-요구서-app공통출력물.md:176-190`). The GI screen additionally fixes the HU alternative (`.design-reference/omf-mes/design/wiki/screens/01/P-01-02-출고QR발행.md:64-70`).
- Therefore a missing predicate for one input family is not evidence to hold every POST family. Repository procedure says use literal precedent first, separate edge from main, then prefer explicit rejection/no quiet derivation (`docs/coverage-100/README.md:39-55`). Root decides each branch.

## 2. Proven acceptance witnesses and remaining gaps

### `MATERIAL_LOT_LABEL + LOT`

**Fixed facts.** `targetId = lotId`, and `lot_id` is that same FK (`screens/01/P-01-01-자재LOT등록라벨발행.md:80-94,205`). This screen's LOT is material with source `INBOUND_RECEIPT_LINE + line id` (`.../P-01-01-자재LOT등록라벨발행.md:108-125`). The production writer agrees: inbound receipt passes `MATERIAL` and `INBOUND_RECEIPT_LINE` (`src/logistics/inbound-receipt/inbound-receipt.service.ts:119-137`).

**Normal witness.** Registration deliberately creates `status_code = INSPECTION_PENDING` and an active incoming-inspection hold (`src/core/lot/lot-registry.service.ts:15-23,76-104`). The screen calls LOT creation, then record creation, and explicitly retains this partially completed state (`screens/01/P-01-01-자재LOT등록라벨발행.md:140-174`). Thus at least `{type=MATERIAL, source=INBOUND_RECEIPT_LINE, status=INSPECTION_PENDING, active incoming hold}` is an affirmative normal path; an active hold or non-`NORMAL` status cannot be a blanket rejection.

**Still missing.** These sources do not close the exhaustive later-state/reissue predicate. They prove the initial-pending subset, not whether later `DEFECTIVE`/`SCRAPPED` material can be reissued.

### `PRODUCTION_LOT_LABEL + LOT`

**Fixed facts.** `targetId = lotId = lot_id`; only completed production LOTs qualify, including under-complete closure (`screens/02/P-02-07-LOT라벨출력부착.md:55-69,77-104`). Production allocation creates `lot_type_code=PRODUCTION`, `source_type_code=WORK_ORDER`, initially `INSPECTION_PENDING/WAITING` (`src/core/lot/lot-registry.service.ts:126-159`). Completion locks the LOT, requires the work-order source, and sets `completed_at` for both normal and under completion (`src/trace/lot/lot-complete.service.ts:65-103,115-123`).

**Quality fact.** The frozen screen separately says “2-stage labels, good product only” (`screens/02/P-02-07-LOT라벨출력부착.md:23-30`). The implemented transition table maps inspection accepted→`NORMAL`, held→`INSPECTION_PENDING`, rejected→`DEFECTIVE` (`src/core/document-state/transitions.ts:192-203`). Therefore `completed_at IS NOT NULL` proves completion, not quality; the stored positive quality evidence is `status_code = NORMAL` rather than completion judgment or quantity attainment.

**Candidate affirmative subset, not root R.** Exact pair + same LOT FK + `PRODUCTION`/`WORK_ORDER` + `completed_at IS NOT NULL` + `status_code = NORMAL`. It includes under-complete good LOTs and invents no terminal/process/master flag. Whether `NORMAL` is the exhaustive print predicate remains root-owned.

### `CERTIFICATE_OF_ANALYSIS + INSPECTION_RESULT`

**Fixed facts.** The target axis is the inspection result (`api-contracts/06-API-요구서-app공통출력물.md:155-165,176-190`). The result has nullable judgment and `confirmed_at`; its request has nullable `lot_id` (`prisma/schema.prisma:3339-3369,3373-3405`). The screen fixes one-stage operation as saving `confirmed_at` and states that the remaining blocker is the CoA format, not the record contract (`screens/04/W-04-03-OQC출하검사판정.md:147-182`). It still disables the rendition-facing button for that format (`.../W-04-03-OQC출하검사판정.md:184-190,205-229`).

**Source-head facts.** I-19 create at `bc6d07dca14172f71f20158cc0c35d2c0ce9dc3a:src/quality/inspection/inspection-result-write.service.ts:71-117` sets `confirmed_at` when born `CONFIRMED`. Update at `37ecc768424abcbfc18e2f5065fd26987d330f11:src/quality/inspection/inspection-result-write.service.ts:136-185` rejects editing a confirmed result and otherwise uses an optimistic `updateMany`; both heads say confirm side effects come later (`...:57-62` and `...:74-78`).

**Candidate affirmative subset, not root R.** Existing `INSPECTION_RESULT` with `status_code=CONFIRMED` and non-null `confirmed_at`; derive `lotId` only from its request's nullable FK (same value or null). No frozen text says CoA is `ACCEPTED`-only, so do not invent `PASS`, “latest inspection,” or a nearby LOT. Format absence can hold rendition/button without necessarily holding record-only POST. Final confirmation-writer lock order is still missing from the available source heads.

### `PACKING_LABEL + HANDLING_UNIT`

**Fixed facts.** The canonical map says packing, and P-04-02 fixes a packing unit with `lot_id = NULL` because an HU may contain several LOTs (`screens/04/P-04-02-납품포장라벨출력.md:81-95,144-157`). P-04-04 repeats `PACKING_LABEL`, packing target, and null LOT (`screens/04/P-04-04-재구성신규라벨발행.md:76-95`). P-04-02 opens record creation and keeps rendering/printing outside it (`.../P-04-02-납품포장라벨출력.md:178-196,215-240`).

**Normal witness.** An existing HU with exact pair and request `lotId = NULL` is supported. Neither cited P-04 path declares nonempty contents as PACKING eligibility, so importing the GI empty-HU rule would be a quiet cross-document derivation.

**Still missing/conflicting.** HU has a status and contents in the model (`prisma/schema.prisma:415-459`), but current `src` has no production `handling_unit`/`handling_unit_content` create/update/delete call (static `rg`, 0 matches). P-04-04's label-pending HU status producer is explicitly unresolved (`screens/04/P-04-04-재구성신규라벨발행.md:99-110`). P-02-09 instead emits `PACKING_LABEL + LOT` for LOT packaging (`screens/02/P-02-09-포장라벨인식표재출력.md:58-98`); do not silently allow or translate that conflicting branch.

### `GOODS_ISSUE_QR + GOODS_ISSUE_LINE`

**Fixed facts.** Line target uses the line PK and `lot_id` must equal that line's required LOT FK (`screens/01/P-01-02-출고QR발행.md:115-137`; `prisma/schema.prisma:775-800`). The screen says the target always arises on issue confirmation (`.../P-01-02-출고QR발행.md:139-153`). Source moves the parent header to `POSTED` (`src/logistics/goods-issue/goods-issue.service.ts:190-197`).

**Candidate affirmative subset, not root R.** Existing line whose parent is `POSTED`, with request `lotId = line.lot_id`. This is based on persisted issue state, not an invented quality predicate. Do not blanket-reject non-`NORMAL` LOTs: the actual posting code says that would erase disposal and return flows and instead consults `judgment_type_control.blocks_issue` (`src/logistics/goods-issue/issue-posting.ts:297-323`). That posting control is not evidence for a second print-time quality gate.

### `GOODS_ISSUE_QR + HANDLING_UNIT`

**Fixed facts.** HU target and `lot_id=NULL` are explicit; an empty HU is explicitly rejected (`screens/01/P-01-02-출고QR발행.md:132-137,204-214`).

**Normal witness/gap.** Existing HU + at least one `handling_unit_content` row + null request LOT is the smallest literal subset. However, neither `handling_unit` nor contents has a goods-issue relation (`prisma/schema.prisma:415-459`), and the screen leaves the HU creator unresolved (`screens/01/P-01-02-출고QR발행.md:230-241`). The POST body also carries no goods-issue id. Thus source cannot prove that an arbitrary nonempty HU belongs to a selected/posted issue; root must either accept the literal subset or explicitly hold this input family.

## 3. Real writer lock graph

| Validated target/fact | Existing writer order | Evidence | Compatible validation order |
|---|---|---|---|
| LOT identity/status/completion | quality: LOT ids ascending `FOR UPDATE`; completion: LOT `FOR UPDATE`; ordinary edit: optimistic `UPDATE` | `src/core/lot/lot-quality-status.service.ts:58-79`; `src/trace/lot/lot-complete.service.ts:65-103,115-123`; `src/trace/lot/lot.service.ts:179-211` | LOT ids ascending `FOR NO KEY UPDATE`, then validate/insert |
| GI line, its parent state, its LOT | line replace/post both lock parent header `FOR UPDATE`, then read/change lines; line replace may delete/recreate/change `lot_id` | `src/logistics/goods-issue/goods-issue-update.service.ts:41-48,78-150,223-237`; `src/logistics/goods-issue/goods-issue.service.ts:200-260` | distinct header ids ascending `FOR NO KEY UPDATE`; re-read line+lot after parent lock; then LOT ids ascending `FOR NO KEY UPDATE` |
| HU row / nonempty contents | no current production writer found; child has HU and LOT FKs | `prisma/schema.prisma:415-459` | HU ids ascending `FOR NO KEY UPDATE`; if nonempty is required, also lock one qualifying content row. Writer-order completeness remains unproved |
| inspection result / request LOT | available create; draft update is optimistic; confirmed update rejected; final confirm writer absent from observed heads | I-19 commits cited in §2 | A result `FOR NO KEY UPDATE` can serialize ordinary row updates, but do not declare the cross-result/request/LOT order complete until the confirm writer lands |

### Why `NO KEY UPDATE`, not `UPDATE`, matters for LOT

- Inserting `document_issue_log.lot_id`, `goods_issue_line.lot_id`, or `handling_unit_content.lot_id` takes the referenced LOT's FK key-share protection (`prisma/schema.prisma:197,455,791`).
- `FOR NO KEY UPDATE` conflicts with row updates and the existing stronger `FOR UPDATE` quality/completion writers, but it is compatible with that FK key-share. It therefore stabilizes eligibility without creating the known “document holds LOT; GI writer holds header then waits on LOT FK; document waits on header” inversion.
- `FOR UPDATE` conflicts with FK key-share. The old LOT-first/`FOR UPDATE` proposal is therefore unsafe against the real GI parent-first line writer. For GI targets, parent-header first and post-lock re-read is required; locking only the polymorphic line target does not follow the ownership writer.
- These are static PostgreSQL lock consequences, not a runtime deadlock/PASS claim.

## 4. MOLD side note (already conditional)

`mold.update()` reads editability/count before its versioned update (`src/mdm/mold/mold.service.ts:184-213`), while label count is a separate query (`src/mdm/mold/mold.service.ts:292-300`). A concurrent first issue can land after count=0 yet before `updateMany`; locking only on the issue side cannot repair that writer race. Keep TOOL_LABEL+MOLD conditional until root assigns an atomic writer-side recheck; this audit proposes no fix.

## 5. Root hand-back

- Evidence supports affirmative subsets for material initial-pending LOT, production completed+`NORMAL` LOT, confirmed inspection result, existing packing HU with null LOT, and posted GI line with exact line LOT.
- GI HU still lacks issue ownership evidence/writer convention; PACKING+LOT remains a frozen conflict; material later-state reissue and final inspection-confirm lock order remain incomplete.
- No contract, schema, source, test, or shared plan was changed. Root retains every policy/support-set/implementation decision.
