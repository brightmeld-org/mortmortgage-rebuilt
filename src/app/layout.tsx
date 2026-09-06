// Root layout. This build uses built-in credential auth (task-006..009) —
// deliberately no Clerk / no third-party auth provider anywhere.
//
// Fonts follow the frame (frame/artifact.html): Fraunces for display headings,
// Public Sans for UI text — self-hosted through next/font (CSP font-src 'self').
import type { Metadata } from "next";
import { Fraunces, Public_Sans } from "next/font/google";
import "./globals.css";

// INV-050 (BUG-34): the SEC-17 per-request CSP nonce forbids build-time static
// prerendering — prerendered HTML is frozen before the middleware mints the
// response's nonce, so its script tags can never match the CSP header and the
// browser blocks all client JS. This root-level export forces request-time
// rendering for every HTML route (all pages, all layouts, not-found) and is the
// single mechanism new pages inherit by default; no child segment may opt back
// into static rendering while the nonce CSP stands. Ratcheted by the task-046
// build-mode suite (zero prerendered page routes in the production build).
export const dynamic = "force-dynamic";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  display: "swap",
});

const publicSans = Public_Sans({
  subsets: ["latin"],
  variable: "--font-public-sans",
  display: "swap",
});

// Title convention (task-044): every page sets its own full
// "Page name — MortMortgage" title (established increments 2-10 — no template,
// which would double-suffix them); this default covers routes without one.
// Favicon: src/app/icon.svg is auto-served by the app router and linked in
// <head> on every page.
export const metadata: Metadata = {
  title: "MortMortgage",
  description: "Mortgage Application Management System",
  applicationName: "MortMortgage",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${fraunces.variable} ${publicSans.variable}`}>
      <body className="min-h-screen bg-paper font-sans text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
