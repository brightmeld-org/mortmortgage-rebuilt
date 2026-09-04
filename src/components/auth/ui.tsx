// Presentational primitives shared by the AuthPages suite (task-009).
// Styling follows the frame: white card on paper ground, Fraunces display
// headings, navy primary buttons, copper links, semantic banner colors
// (frame/screen-signin.png + frame/artifact.html palette).

import type { ReactNode } from "react";
import clsx from "clsx";

/** Centered single-purpose card (frame sign-in layout). */
export function AuthCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={clsx(
        "w-full rounded-xl border border-line bg-card p-8 shadow-[0_1px_3px_rgba(29,39,51,0.06)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function AuthHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="mb-6">
      <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">{title}</h1>
      {subtitle ? <p className="mt-1.5 text-sm text-info">{subtitle}</p> : null}
    </header>
  );
}

/** Labeled input row. Server messages render verbatim beneath via `error`. */
export function Field({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string | null;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && !error ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
      {error ? (
        <p className="mt-1 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const inputClass = (invalid?: boolean) =>
  clsx(
    "w-full rounded-md border bg-card px-3 py-2 text-sm text-ink placeholder:text-muted",
    "transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]",
    "focus:outline-none focus:ring-2 focus:ring-navy/25",
    invalid ? "border-danger focus:border-danger" : "border-line focus:border-navy",
  );

/** Primary (navy) submit button with explicit loading/disabled states. */
export function PrimaryButton({
  children,
  testId,
  loading,
  disabled,
  type = "submit",
  onClick,
}: {
  children: ReactNode;
  testId: string;
  loading?: boolean;
  disabled?: boolean;
  type?: "submit" | "button";
  onClick?: () => void;
}) {
  return (
    <button
      type={type}
      data-testid={testId}
      onClick={onClick}
      disabled={disabled || loading}
      className={clsx(
        "w-full rounded-md bg-navy px-4 py-2.5 text-sm font-semibold text-white",
        "transition-colors duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]",
        "hover:bg-navy-deep active:translate-y-px",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-navy/40 focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:bg-navy/45",
      )}
    >
      {loading ? "Please wait…" : children}
    </button>
  );
}

/**
 * Error banner — renders the server's ErrorResponse text VERBATIM (message +
 * details[]). One rendering for every failure cause (uniform-error rule).
 */
export function ErrorBanner({
  message,
  details,
  testId,
}: {
  message: string;
  details?: string[];
  testId: string;
}) {
  return (
    <div
      role="alert"
      data-testid={testId}
      className="mb-4 rounded-md border border-danger/30 bg-danger-soft px-3.5 py-2.5 text-sm text-danger"
    >
      <p>{message}</p>
      {details && details.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** Success banner (Ack messages render verbatim). */
export function SuccessBanner({ message, testId }: { message: string; testId: string }) {
  return (
    <div
      role="status"
      data-testid={testId}
      className="mb-4 rounded-md border border-success/30 bg-success-soft px-3.5 py-2.5 text-sm text-success"
    >
      {message}
    </div>
  );
}

/** Copper text link (frame link treatment). */
export function CopperLink({
  href,
  testId,
  children,
}: {
  href: string;
  testId?: string;
  children: ReactNode;
}) {
  return (
    // eslint-disable-next-line @next/next/no-html-link-for-pages -- typed-route-safe plain anchor for auth flows
    <a
      href={href}
      data-testid={testId}
      className="text-sm font-medium text-copper transition-colors duration-200 hover:text-navy"
    >
      {children}
    </a>
  );
}

/** Skeleton shimmer block for async loads (delivery-fidelity loading states). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-md bg-gray-soft", className)} aria-hidden="true" />;
}
