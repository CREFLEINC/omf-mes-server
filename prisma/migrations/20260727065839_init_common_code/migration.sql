-- CreateEnum
CREATE TYPE "DataSource" AS ENUM ('ERP', 'MES');

-- CreateTable
CREATE TABLE "mst_code_group" (
    "code_group" VARCHAR(50) NOT NULL,
    "name_ko" VARCHAR(200) NOT NULL,
    "name_vi" VARCHAR(200),
    "description" VARCHAR(500),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "use_yn" BOOLEAN NOT NULL DEFAULT true,
    "source" "DataSource" NOT NULL DEFAULT 'MES',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(50),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" VARCHAR(50),
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "mst_code_group_pkey" PRIMARY KEY ("code_group")
);

-- CreateTable
CREATE TABLE "mst_code_value" (
    "id" UUID NOT NULL,
    "code_group" VARCHAR(50) NOT NULL,
    "code_value" VARCHAR(50) NOT NULL,
    "name_ko" VARCHAR(200) NOT NULL,
    "name_vi" VARCHAR(200),
    "description" VARCHAR(500),
    "attr1" VARCHAR(200),
    "attr2" VARCHAR(200),
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "use_yn" BOOLEAN NOT NULL DEFAULT true,
    "source" "DataSource" NOT NULL DEFAULT 'MES',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(50),
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    "updated_by" VARCHAR(50),
    "deleted_at" TIMESTAMPTZ(3),

    CONSTRAINT "mst_code_value_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mst_code_group_use_yn_sort_order_idx" ON "mst_code_group"("use_yn", "sort_order");

-- CreateIndex
CREATE INDEX "mst_code_group_deleted_at_idx" ON "mst_code_group"("deleted_at");

-- CreateIndex
CREATE INDEX "mst_code_value_code_group_use_yn_sort_order_idx" ON "mst_code_value"("code_group", "use_yn", "sort_order");

-- CreateIndex
CREATE INDEX "mst_code_value_deleted_at_idx" ON "mst_code_value"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "mst_code_value_code_group_code_value_key" ON "mst_code_value"("code_group", "code_value");

-- AddForeignKey
ALTER TABLE "mst_code_value" ADD CONSTRAINT "mst_code_value_code_group_fkey" FOREIGN KEY ("code_group") REFERENCES "mst_code_group"("code_group") ON DELETE RESTRICT ON UPDATE CASCADE;
