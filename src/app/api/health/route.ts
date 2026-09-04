// GET /api/health — public health probe (NFR-001, NFR-027, AC-53).
// Response shape: HealthStatus from contracts.md §A — { status, version, database, storage, time }.
// 200 when all dependency checks pass, 503 when any dependency fails. No per-request
// config loading: the storage service resolves STORAGE_PROVIDER (+ its config) once at
// module load, and the probe checks the CONFIGURED adapter — local-dir writability or
// S3 bucket reachability (task-045).
import { logged } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { checkStorageHealth } from "@/lib/services/storage";
import pkg from "../../../../package.json";

const VERSION: string = pkg.version;

type DependencyState = "ok" | "fail";

async function checkDatabase(): Promise<DependencyState> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return "ok";
  } catch {
    return "fail";
  }
}

async function GET_impl() {
  const [database, storage] = await Promise.all([checkDatabase(), checkStorageHealth()]);
  const healthy = database === "ok" && storage === "ok";
  return Response.json(
    {
      status: healthy ? "ok" : "degraded",
      version: VERSION,
      database,
      storage,
      time: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503 },
  );
}

// task-045 (NFR-027): handlers egress through the structured request-log wrapper.
export const GET = logged(GET_impl);
