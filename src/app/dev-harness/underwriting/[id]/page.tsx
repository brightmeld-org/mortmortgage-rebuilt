// task-026 EVIDENCE HARNESS — NOT a product route (not part of the §8 route
// inventory; the panel's real mount is the task-029 StaffApplicationDetail
// Underwriting tab, built later this increment).
//
// Mounts <UnderwritingPanel /> standalone so the task-026 browser evidence in
// verification/increment-7/task-026/ has a stable mount; the file is KEPT so
// Lens can re-run that evidence. Gated to the evidence posture only: any
// production build OR non-demo run 404s via notFound() before rendering.
// No data leaks through the gate regardless — the page itself fetches
// nothing; every request the mounted panel makes (/checks, /qualification)
// is authenticated + role/record-scoped server-side by the §B route guards,
// so an unauthenticated visitor sees only empty panel shells with 401 errors.
//
// Query params: ?lat=..&lng=..&label=.. supply the geocoded subject property
// (normally wired by the detail page from SubjectProperty.geocode).

import { notFound } from "next/navigation";
import { UnderwritingPanel } from "@/components/staff/underwriting/UnderwritingPanel";

export default async function UnderwritingHarnessPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production" || process.env.DEMO_MODE !== "true") notFound();

  const { id } = await params;
  const query = await searchParams;
  const lat = Number(typeof query.lat === "string" ? query.lat : NaN);
  const lng = Number(typeof query.lng === "string" ? query.lng : NaN);
  const label = typeof query.label === "string" ? query.label : undefined;
  const subject =
    Number.isFinite(lat) && Number.isFinite(lng)
      ? { latitude: lat, longitude: lng, label }
      : null;

  return (
    <main className="mx-auto max-w-6xl bg-paper px-4 py-8">
      <h1 className="mb-4 font-display text-2xl font-bold text-ink">
        Underwriting panel harness (dev only)
      </h1>
      <UnderwritingPanel applicationId={id} subject={subject} />
    </main>
  );
}
