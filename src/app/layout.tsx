// Root layout. This build uses built-in credential auth (task-006..009) —
// deliberately no Clerk / no third-party auth provider anywhere.
//
// Fonts follow the frame (frame/artifact.html): Fraunces for display headings,
// Public Sans for UI text — self-hosted through next/font (CSP font-src 'self').
import type { Metadata } from "next";
import { Fraunces, Public_Sans } from "next/font/google";
import "./globals.css";

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
