-- Export the application PostgreSQL catalog as one JSON document.
-- Run after all Prisma migrations have been applied.
WITH application_tables AS (
    SELECT
        c.oid AS table_oid,
        n.nspname AS schema_name,
        c.relname AS table_name,
        c.relispartition AS is_partition,
        obj_description(c.oid, 'pg_class') AS description
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
      AND n.nspname NOT LIKE 'pg_toast%'
),
columns AS (
    SELECT
        t.table_oid,
        jsonb_agg(
            jsonb_build_object(
                'name', a.attname,
                'ordinal', a.attnum,
                'data_type', format_type(a.atttypid, a.atttypmod),
                'nullable', NOT a.attnotnull,
                'default', pg_get_expr(d.adbin, d.adrelid),
                'description', col_description(a.attrelid, a.attnum)
            ) ORDER BY a.attnum
        ) AS value
    FROM application_tables t
    JOIN pg_attribute a ON a.attrelid = t.table_oid
                       AND a.attnum > 0
                       AND NOT a.attisdropped
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    GROUP BY t.table_oid
),
primary_keys AS (
    SELECT
        t.table_oid,
        jsonb_agg(a.attname ORDER BY k.ordinality) AS value
    FROM application_tables t
    JOIN pg_constraint con ON con.conrelid = t.table_oid AND con.contype = 'p'
    JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality) ON true
    JOIN pg_attribute a ON a.attrelid = t.table_oid AND a.attnum = k.attnum
    GROUP BY t.table_oid
),
foreign_keys AS (
    SELECT
        t.table_oid,
        jsonb_agg(
            jsonb_build_object(
                'name', con.conname,
                'columns', source_columns.value,
                'target_schema', target_ns.nspname,
                'target_table', target_table.relname,
                'target_columns', target_columns.value,
                'on_update', CASE con.confupdtype
                    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                    WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                    WHEN 'd' THEN 'SET DEFAULT' END,
                'on_delete', CASE con.confdeltype
                    WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                    WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                    WHEN 'd' THEN 'SET DEFAULT' END
            ) ORDER BY con.conname
        ) AS value
    FROM application_tables t
    JOIN pg_constraint con ON con.conrelid = t.table_oid AND con.contype = 'f'
    JOIN pg_class target_table ON target_table.oid = con.confrelid
    JOIN pg_namespace target_ns ON target_ns.oid = target_table.relnamespace
    JOIN LATERAL (
        SELECT jsonb_agg(a.attname ORDER BY k.ordinality) AS value
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    ) source_columns ON true
    JOIN LATERAL (
        SELECT jsonb_agg(a.attname ORDER BY k.ordinality) AS value
        FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
    ) target_columns ON true
    GROUP BY t.table_oid
),
unique_constraints AS (
    SELECT
        t.table_oid,
        jsonb_agg(
            jsonb_build_object(
                'name', con.conname,
                'columns', key_columns.value
            ) ORDER BY con.conname
        ) AS value
    FROM application_tables t
    JOIN pg_constraint con ON con.conrelid = t.table_oid AND con.contype = 'u'
    JOIN LATERAL (
        SELECT jsonb_agg(a.attname ORDER BY k.ordinality) AS value
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    ) key_columns ON true
    GROUP BY t.table_oid
),
checks AS (
    SELECT
        t.table_oid,
        jsonb_agg(
            jsonb_build_object(
                'name', con.conname,
                'expression', pg_get_constraintdef(con.oid, true)
            ) ORDER BY con.conname
        ) AS value
    FROM application_tables t
    JOIN pg_constraint con ON con.conrelid = t.table_oid AND con.contype = 'c'
    GROUP BY t.table_oid
),
tables AS (
    SELECT jsonb_agg(
        jsonb_build_object(
            'schema', t.schema_name,
            'name', t.table_name,
            'qualified_name', t.schema_name || '.' || t.table_name,
            'description', t.description,
            'is_partition', t.is_partition,
            'primary_key', COALESCE(pk.value, '[]'::jsonb),
            'columns', COALESCE(cols.value, '[]'::jsonb),
            'foreign_keys', COALESCE(fk.value, '[]'::jsonb),
            'unique_constraints', COALESCE(uq.value, '[]'::jsonb),
            'checks', COALESCE(ck.value, '[]'::jsonb)
        ) ORDER BY t.schema_name, t.table_name
    ) AS value
    FROM application_tables t
    LEFT JOIN columns cols ON cols.table_oid = t.table_oid
    LEFT JOIN primary_keys pk ON pk.table_oid = t.table_oid
    LEFT JOIN foreign_keys fk ON fk.table_oid = t.table_oid
    LEFT JOIN unique_constraints uq ON uq.table_oid = t.table_oid
    LEFT JOIN checks ck ON ck.table_oid = t.table_oid
),
relations AS (
    SELECT jsonb_agg(
        jsonb_build_object(
            'name', con.conname,
            'source_schema', source_ns.nspname,
            'source_table', source_table.relname,
            'source_columns', source_columns.value,
            'target_schema', target_ns.nspname,
            'target_table', target_table.relname,
            'target_columns', target_columns.value,
            'on_delete', CASE con.confdeltype
                WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT'
                WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL'
                WHEN 'd' THEN 'SET DEFAULT' END
        ) ORDER BY source_ns.nspname, source_table.relname, con.conname
    ) AS value
    FROM pg_constraint con
    JOIN pg_class source_table ON source_table.oid = con.conrelid
    JOIN pg_namespace source_ns ON source_ns.oid = source_table.relnamespace
    JOIN pg_class target_table ON target_table.oid = con.confrelid
    JOIN pg_namespace target_ns ON target_ns.oid = target_table.relnamespace
    JOIN LATERAL (
        SELECT jsonb_agg(a.attname ORDER BY k.ordinality) AS value
        FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    ) source_columns ON true
    JOIN LATERAL (
        SELECT jsonb_agg(a.attname ORDER BY k.ordinality) AS value
        FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ordinality)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
    ) target_columns ON true
    WHERE con.contype = 'f'
      AND source_ns.nspname NOT IN ('pg_catalog', 'information_schema')
      AND source_ns.nspname NOT LIKE 'pg_toast%'
)
SELECT jsonb_pretty(jsonb_build_object(
    'model_version', '4.0',
    'design_reference_commit', 'a8f46f2',
    'database', 'PostgreSQL 16',
    'tables', COALESCE(tables.value, '[]'::jsonb),
    'relationships', COALESCE(relations.value, '[]'::jsonb)
))
FROM tables, relations;
