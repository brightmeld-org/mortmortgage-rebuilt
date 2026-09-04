"use client";

// Authenticated top-nav header (task-017, completed by task-044 AppShell) —
// frame/gui-spec.md global layout model: top-nav, NO side nav. Logo → role
// home, role-appropriate links (RFP §8 nav paragraph), notification bell
// (task-037) + user menu (profile, sign out), hamburger collapse on narrow
// widths. Supervisor extra pages (Outbound Messages, System Status, Exports,
// Demo Data — demo mode only) live in a frame-consistent secondary "System"
// dropdown grouping (frame gui-spec navigation: "sup-system / sup-outbound /
// sup-demo-data / sup-exports reachable from supervisor nav (secondary group
// or user-menu section)" — logged in frame-extensions.md).
//
// Keyboard operability (AC-60): both dropdown menus open on click/Enter,
// ArrowUp/ArrowDown/Home/End move between menu items, Escape closes and
// returns focus to the trigger, outside click closes.

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { getSession, postJsonWithCsrf } from "@/components/auth/api";
import { NotificationBell } from "@/components/borrower/NotificationBell";

export interface HeaderSession {
  role: "BORROWER" | "CASEWORKER" | "SUPERVISOR";
  firstName: string;
  lastName: string;
  email: string;
}

interface NavLink {
  href: string;
  label: string;
  testId: string;
}

const ROLE_HOME: Record<HeaderSession["role"], string> = {
  BORROWER: "/dashboard",
  CASEWORKER: "/caseworker/queue",
  SUPERVISOR: "/supervisor",
};

const ROLE_LABEL: Record<HeaderSession["role"], string> = {
  BORROWER: "Borrower",
  CASEWORKER: "Caseworker",
  SUPERVISOR: "Supervisor",
};

function navFor(role: HeaderSession["role"]): NavLink[] {
  switch (role) {
    case "BORROWER":
      return [
        { href: "/dashboard", label: "Dashboard", testId: "nav-dashboard" },
        { href: "/applications/new", label: "New Application", testId: "nav-new-application" },
        { href: "/profile", label: "Profile", testId: "nav-profile" },
      ];
    case "CASEWORKER":
      return [
        { href: "/caseworker/queue", label: "Queue", testId: "nav-queue" },
        { href: "/caseworker/history", label: "Completion History", testId: "nav-history" },
        { href: "/profile", label: "Profile", testId: "nav-profile" },
      ];
    case "SUPERVISOR":
      // Six primary links per RFP §8 nav paragraph + frame supervisor header.
      // (testid nav-sup-staff is canonical from increment 7 — label follows
      // the frame's "Caseworkers".)
      return [
        { href: "/supervisor", label: "All Applications", testId: "nav-sup-applications" },
        { href: "/supervisor/analytics", label: "Analytics", testId: "nav-sup-analytics" },
        { href: "/supervisor/caseworkers", label: "Caseworkers", testId: "nav-sup-staff" },
        { href: "/supervisor/audit-log", label: "Audit Log", testId: "nav-sup-audit-log" },
        { href: "/supervisor/settings", label: "Settings", testId: "nav-sup-settings" },
        { href: "/profile", label: "Profile", testId: "nav-profile" },
      ];
  }
}

/** Supervisor secondary "System" group (frame: secondary group in header). */
function systemNavFor(role: HeaderSession["role"], demoMode: boolean): NavLink[] {
  if (role !== "SUPERVISOR") return [];
  const links: NavLink[] = [
    { href: "/supervisor/outbound", label: "Outbound Messages", testId: "nav-sup-outbound" },
    { href: "/supervisor/system", label: "System Status", testId: "nav-sup-system" },
    { href: "/supervisor/exports", label: "Exports", testId: "nav-sup-exports" },
  ];
  // Demo Data link only in demo mode — the route itself is absent otherwise.
  if (demoMode) {
    links.push({ href: "/supervisor/demo-data", label: "Demo Data", testId: "nav-sup-demo-data" });
  }
  return links;
}

function isActive(pathname: string, href: string): boolean {
  if (href === "/supervisor") return pathname === "/supervisor";
  if (href === "/dashboard") return pathname === "/dashboard" || pathname.startsWith("/applications/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Menu-button keyboard pattern shared by the user menu and the System group:
 * ArrowDown/ArrowUp/Home/End move focus among [role=menuitem]s, Escape closes
 * and refocuses the trigger.
 */
function menuKeyDown(
  event: React.KeyboardEvent,
  container: HTMLElement | null,
  close: (refocus: boolean) => void,
) {
  if (!container) return;
  if (event.key === "Escape") {
    event.preventDefault();
    close(true);
    return;
  }
  const items = Array.from(
    container.querySelectorAll<HTMLElement>("[role=menuitem]:not([disabled])"),
  );
  if (items.length === 0) return;
  const currentIndex = items.findIndex((item) => item === document.activeElement);
  let nextIndex = -1;
  if (event.key === "ArrowDown") nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0;
  else if (event.key === "ArrowUp") nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1;
  else if (event.key === "Home") nextIndex = 0;
  else if (event.key === "End") nextIndex = items.length - 1;
  if (nextIndex >= 0) {
    event.preventDefault();
    items[nextIndex].focus();
  }
}

export function AppHeader({ session, demoMode = false }: { session: HeaderSession; demoMode?: boolean }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [systemOpen, setSystemOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const systemRef = useRef<HTMLDivElement>(null);
  const systemTriggerRef = useRef<HTMLButtonElement>(null);

  const links = navFor(session.role);
  const systemLinks = systemNavFor(session.role, demoMode);
  const systemActive = systemLinks.some((link) => isActive(pathname, link.href));
  const initials =
    `${session.firstName.charAt(0)}${session.lastName.charAt(0)}`.toUpperCase() || "?";

  // Supervisor nav carries 6 primary links + the System group → collapse to
  // the hamburger below lg; the shorter borrower/caseworker navs collapse
  // below sm. Both class sets are static literals for the Tailwind compiler.
  const wide = session.role === "SUPERVISOR";
  const desktopNavClass = wide ? "hidden items-center gap-1 lg:flex" : "hidden items-center gap-1 sm:flex";
  const hamburgerClass = wide
    ? "flex h-9 w-9 items-center justify-center rounded-md border border-line text-ink-soft transition-colors duration-200 hover:text-copper lg:hidden"
    : "flex h-9 w-9 items-center justify-center rounded-md border border-line text-ink-soft transition-colors duration-200 hover:text-copper sm:hidden";
  const mobileNavClass = wide
    ? "border-t border-line bg-card px-3 py-2 lg:hidden"
    : "border-t border-line bg-card px-3 py-2 sm:hidden";

  const closeUserMenu = useCallback((refocus: boolean) => {
    setMenuOpen(false);
    if (refocus) menuTriggerRef.current?.focus();
  }, []);
  const closeSystemMenu = useCallback((refocus: boolean) => {
    setSystemOpen(false);
    if (refocus) systemTriggerRef.current?.focus();
  }, []);

  useEffect(() => {
    function onDown(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
      if (systemRef.current && !systemRef.current.contains(event.target as Node)) setSystemOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  async function onSignOut() {
    setSigningOut(true);
    const info = await getSession();
    if (info) {
      await postJsonWithCsrf("/api/auth/sign-out", info.csrfToken);
    }
    window.location.assign("/sign-in");
  }

  function renderLink(link: NavLink, mobile: boolean) {
    const active = isActive(pathname, link.href);
    const base = mobile
      ? "block rounded-md px-3 py-2 text-sm font-medium transition-colors duration-200"
      : "rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-200";
    return (
      <a
        key={link.testId}
        href={link.href}
        data-testid={mobile ? `${link.testId}-mobile` : link.testId}
        aria-current={active ? "page" : undefined}
        className={`${base} ${active ? "bg-copper-soft text-copper" : "text-ink-soft hover:text-copper"}`}
        onClick={() => setMobileOpen(false)}
      >
        {link.label}
      </a>
    );
  }

  return (
    <header className="sticky top-0 z-40 border-b border-line bg-card">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-5">
          {/* Hamburger (collapsed nav) */}
          <button
            type="button"
            data-testid="nav-hamburger"
            aria-label={mobileOpen ? "Close navigation menu" : "Open navigation menu"}
            aria-expanded={mobileOpen}
            onClick={() => setMobileOpen((open) => !open)}
            className={hamburgerClass}
          >
            <span aria-hidden className="text-lg leading-none">≡</span>
          </button>
          <a
            href={ROLE_HOME[session.role]}
            data-testid="app-logo-link"
            className="font-display text-xl font-bold tracking-tight"
          >
            <span className="text-navy-deep">Mort</span>
            <span className="text-copper">Mortgage</span>
          </a>
          <nav aria-label="Primary" className={desktopNavClass}>
            {links.map((link) => renderLink(link, false))}
            {systemLinks.length > 0 ? (
              <div ref={systemRef} className="relative">
                <button
                  ref={systemTriggerRef}
                  type="button"
                  data-testid="nav-sup-system-menu"
                  aria-haspopup="menu"
                  aria-expanded={systemOpen}
                  onClick={() => setSystemOpen((open) => !open)}
                  onKeyDown={(e) => menuKeyDown(e, systemRef.current, closeSystemMenu)}
                  className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors duration-200 ${
                    systemActive ? "bg-copper-soft text-copper" : "text-ink-soft hover:text-copper"
                  }`}
                >
                  System
                  <span aria-hidden className="text-[10px] leading-none">▾</span>
                </button>
                {systemOpen ? (
                  <div
                    role="menu"
                    aria-label="System pages"
                    onKeyDown={(e) => menuKeyDown(e, systemRef.current, closeSystemMenu)}
                    className="absolute left-0 mt-2 w-56 rounded-lg border border-line bg-card p-1.5 shadow-lg"
                  >
                    {systemLinks.map((link) => (
                      <a
                        key={link.testId}
                        href={link.href}
                        role="menuitem"
                        data-testid={link.testId}
                        aria-current={isActive(pathname, link.href) ? "page" : undefined}
                        className="block rounded-md px-3 py-2 text-sm text-ink-soft transition-colors duration-200 hover:bg-paper hover:text-ink"
                        onClick={() => setSystemOpen(false)}
                      >
                        {link.label}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </nav>
        </div>

        <div className="flex items-center gap-3">
          {/* Notification bell (task-037) in its reserved mount slot. */}
          <div data-testid="notif-bell-slot">
            <NotificationBell role={session.role} />
          </div>

          <div ref={menuRef} className="relative">
            <button
              ref={menuTriggerRef}
              type="button"
              data-testid="user-menu"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Account menu — ${session.firstName} ${session.lastName}`}
              onClick={() => setMenuOpen((open) => !open)}
              onKeyDown={(e) => menuKeyDown(e, menuRef.current, closeUserMenu)}
              className="flex items-center gap-2 rounded-full py-1 pl-1 pr-2 transition-colors duration-200 hover:bg-paper"
            >
              <span aria-hidden className="flex h-8 w-8 items-center justify-center rounded-full bg-navy text-xs font-bold text-white">
                {initials}
              </span>
              <span className="hidden text-sm font-medium text-ink md:inline">
                {session.firstName} {session.lastName}
              </span>
            </button>
            {menuOpen ? (
              <div
                role="menu"
                aria-label="Account"
                onKeyDown={(e) => menuKeyDown(e, menuRef.current, closeUserMenu)}
                className="absolute right-0 mt-2 w-60 rounded-lg border border-line bg-card p-1.5 shadow-lg"
              >
                <div className="border-b border-line px-3 py-2">
                  <p className="truncate text-sm font-semibold text-ink">
                    {session.firstName} {session.lastName}
                  </p>
                  <p className="truncate text-xs text-muted">{session.email}</p>
                  <p className="mt-0.5 text-xs font-medium text-copper">{ROLE_LABEL[session.role]}</p>
                </div>
                <a
                  href="/profile"
                  role="menuitem"
                  data-testid="user-menu-profile"
                  className="mt-1 block rounded-md px-3 py-2 text-sm text-ink-soft transition-colors duration-200 hover:bg-paper hover:text-ink"
                  onClick={() => setMenuOpen(false)}
                >
                  Profile
                </a>
                <button
                  type="button"
                  role="menuitem"
                  data-testid="sign-out-btn"
                  onClick={onSignOut}
                  disabled={signingOut}
                  className="block w-full rounded-md px-3 py-2 text-left text-sm text-ink-soft transition-colors duration-200 hover:bg-paper hover:text-danger disabled:opacity-50"
                >
                  {signingOut ? "Signing out…" : "Sign out"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {/* Mobile nav drawer */}
      {mobileOpen ? (
        <nav aria-label="Primary mobile" className={mobileNavClass}>
          {links.map((link) => renderLink(link, true))}
          {systemLinks.length > 0 ? (
            <>
              <p className="mt-2 border-t border-line px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">
                System
              </p>
              {systemLinks.map((link) => renderLink(link, true))}
            </>
          ) : null}
        </nav>
      ) : null}
    </header>
  );
}
