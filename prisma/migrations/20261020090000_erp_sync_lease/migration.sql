-- ERP 연동 실행기의 «한 쪽만 돈다» 리스. 블루-그린 전환 중에는 api 가 둘 떠 있어 둘 다 회차를
-- 돌면 같은 행을 두 번 반영한다. 쥔 쪽이 120초마다 늘리고, 죽으면 만료 뒤 다른 쪽이 가져간다.
-- advisory lock 을 쓰지 않는 이유: 세션 잠금은 Prisma 연결 풀에서 연결을 고정할 수 없고,
-- 트랜잭션 잠금은 ERP 를 기다리는 동안 PG 트랜잭션을 열어 두게 된다.
CREATE TABLE integration.sync_lease (
    lease_name  varchar(50)  PRIMARY KEY,
    owner_token varchar(100) NOT NULL,
    expires_at  timestamptz  NOT NULL
);
