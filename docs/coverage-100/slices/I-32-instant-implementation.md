# I-32 P0t exact-microsecond helper implementation

## Outcome

- Added the maintenance-local `MaintenanceInstant` boundary with exact `bigint` epoch microseconds, UTC ISO with six fractional digits, and a PostgreSQL UTC binding string.
- Input parsing mirrors installed Ajv 8.20.0 / ajv-formats 3.0.1 date-time grammar, then rejects only the fixed physical boundaries: leap seconds, nonzero precision beyond six digits, and normalized UTC years outside 0000..9999.
- Stored epoch restoration rejects malformed strings, response-range overflow, and runtime values outside `string | bigint` with ordinary `Error` for the shared 500 filter.
- No operation was registered, so contract coverage remains **355/487**.

## Final verification

| Command | Result | Time |
|---|---|---:|
| `node_modules/.bin/eslint "{src,test}/**/*.ts"` | exit 0 | real 2.55s |
| `node_modules/.bin/tsc --noEmit -p tsconfig.all.json` | exit 0 | real 4.52s |
| `node_modules/.bin/jest --runInBand --no-colors` | exit 0; 101 suites, 987 tests | Jest 5.424s; real 5.65s |
| `TZ=UTC NODE_PATH=/Users/rangkim/projects/crefle/ohmyfactory/apps/omf-mes-server/node_modules/.pnpm/node_modules node -r dotenv/config node_modules/jest/bin/jest.js --config test/jest-e2e.json --no-colors --runInBand test/maintenance-instant.e2e-spec.ts` | exit 0; 1 suite, 8 tests | Jest 0.201s |
| `docker exec omf-mes-lane-b-postgres psql ... pg_stat_activity ...` | exit 0; residual connections 0 | <0.01s |

An earlier focused unit run passed 1 suite / 33 tests in 0.268s before review. The final full unit run supersedes it and includes five added runtime-type cases.

## Failure record

- The first E2E attempt exited 1 in Jest global setup because sandboxed localhost access could not reach `127.0.0.1:55432`; the suite and its SQL did not start.
- The exact assigned container was healthy. The same whole-file command was rerun with narrow local-network escalation and passed, then rerun after review and passed 8/8.
- No lint, type-check, unit-test, or escalated E2E code failure occurred.

## Budget and safety

- Source: 108 physical lines, within the P0t source budget of 150.
- Owned implementation: source 108 + unit 143 + E2E 38 + report 35 = **324 added lines**, no deletions; below the hard 400-line limit.
- E2E used only parameter-bound constant `SELECT` statements against assigned DB `omf_mes_lane_b`; fixture DML, business-table writes, DDL, migration, seed, reset, and whole-E2E execution were all 0.
- Both final and earlier successful E2E processes exited 0, Prisma disconnected in `afterAll`, and post-run `pg_stat_activity` showed 0 residual sessions. The exclusive DB lease was returned.
- Contracts, schema, controllers, DI, core, permissions, source-gate configuration, and existing maintenance GET behavior were not changed. No new error code was added.
- Date never receives the fractional input, SQL uses no `AT TIME ZONE`, future instants are not rejected, and original request/idempotency bodies are not rewritten.
