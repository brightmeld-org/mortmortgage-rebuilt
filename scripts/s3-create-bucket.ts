// Deployment bootstrap (task-045, §7.1): create the configured S3 bucket when
// absent. Used by the docker-compose `storage-init` one-shot service and by
// operators pointing a fresh environment at a new bucket:
//
//   STORAGE_PROVIDER=s3 npm run storage:init
//
// Idempotent — exits 0 whether the bucket was created or already existed.
// Requires the full S3_* configuration (fails fast with the missing variable
// NAMES otherwise — never values).

import { loadS3ConfigFromEnv, S3Storage } from "../src/lib/services/storage";

async function main(): Promise<void> {
  const cfg = loadS3ConfigFromEnv();
  const storage = new S3Storage(cfg);
  const outcome = await storage.ensureBucket();
  process.stdout.write(
    `${JSON.stringify({ timestamp: new Date().toISOString(), level: "info", event: "storage-init", bucket: cfg.bucket, outcome })}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`storage-init failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
