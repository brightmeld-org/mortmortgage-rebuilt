-- CH-015 (INV-045 / VR-136, ASM-001): the company time zone becomes a runtime
-- SystemConfig setting instead of a compile-time constant. Seeds the registry
-- key with its stated default. Idempotent: ON CONFLICT (key) DO NOTHING, so a
-- replay never overwrites an operator change.
INSERT INTO "SystemConfig" ("id", "key", "value", "description", "updatedAt")
VALUES
  (gen_random_uuid()::text, 'company.timeZone', '"America/New_York"'::jsonb, 'IANA time zone identifier for every business-day / SLA deadline computation and every date rendered into an operational or regulatory artifact (INV-045 / ASM-001; default America/New_York).', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
