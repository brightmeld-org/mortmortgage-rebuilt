"use client";

// Right side of the public header: Sign In / Create Account (frame
// screen-landing.png). The frame's sign-in screen omits the button for the page
// you are already on, so the current path's own action is hidden.

import { usePathname } from "next/navigation";

export function PublicHeaderActions() {
  const pathname = usePathname();
  return (
    <div className="flex items-center gap-2.5">
      {pathname !== "/sign-in" ? (
        <a
          href="/sign-in"
          data-testid="public-header-signin"
          className="rounded-md border border-line bg-card px-3.5 py-1.5 text-sm font-semibold text-ink transition-colors duration-200 hover:border-navy hover:text-navy"
        >
          Sign In
        </a>
      ) : null}
      {pathname !== "/sign-up" ? (
        <a
          href="/sign-up"
          data-testid="public-header-signup"
          className="rounded-md bg-copper px-3.5 py-1.5 text-sm font-semibold text-white transition-colors duration-200 hover:bg-navy"
        >
          Create Account
        </a>
      ) : null}
    </div>
  );
}
