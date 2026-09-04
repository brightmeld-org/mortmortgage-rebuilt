/**
 * Shared support for the task-047 §7.7 end-to-end browser suite.
 *
 * Everything here drives the app the way a person does — through the rendered UI,
 * using the §C selector-contract data-testids. The only non-UI reads are against
 * §B endpoint-table paths (never an invented route), and only where a journey needs
 * to look something up that the UI does not surface in a stable place.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type APIResponse,
  type Locator,
  type Page,
} from "@playwright/test";
import * as OTPAuth from "otpauth";

/** Mirrors `use.baseURL` for the API contexts that are minted outside a test fixture. */
export const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:3083";

export const TASK_DIR = path.resolve(process.cwd(), "task-047");
export const AUTH_DIR = path.join(TASK_DIR, ".auth");
export const STATE_FILE = path.join(AUTH_DIR, "run-state.json");
export const AXE_PATH = path.join(TASK_DIR, "vendor", "axe.min.js");

export type DemoRole = "borrower" | "caseworker" | "supervisor";

export const storagePath = (name: string): string => path.join(AUTH_DIR, `${name}.json`);

/** Password used for every account this suite creates. */
export const SUITE_PASSWORD = "E2e-Journey-Phrase-8412";

/**
 * Starts a new run: discards any state left by a previous run and mints a fresh
 * per-run tag. Accounts and applications are keyed off this tag so two runs against
 * the same instance never collide (a reused address would re-register an account
 * whose single-use verification token has already been consumed).
 */
export function startRun(): string {
  mkdirSync(AUTH_DIR, { recursive: true });
  const tag = `e2e-${randomUUID().slice(0, 8)}`;
  writeFileSync(STATE_FILE, JSON.stringify({ runTag: tag }, null, 2));
  return tag;
}

/** Per-run identifier — set by `startRun()` in the setup project. */
export const runTag = (): string => requireState("runTag");

export interface RunState {
  runTag?: string;
  /** Fresh borrower created in setup: full registration → verification → MFA. */
  borrowerEmail?: string;
  borrowerTotpSecret?: string;
  /** Registered + verified but deliberately NOT MFA-enrolled (for the /mfa/enroll scan). */
  preMfaEmail?: string;
  /** Draft produced by the public pre-qualification hand-off. */
  handoffApplicationId?: string;
  /** The live application driven through the whole lifecycle. */
  liveApplicationId?: string;
  liveApplicationNumber?: string;
  /** Document created during the wizard, replaced with a v2 later in the journey. */
  liveDocumentId?: string;
}

export function readState(): RunState {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as RunState;
  } catch {
    return {};
  }
}

export function writeState(patch: RunState): RunState {
  mkdirSync(AUTH_DIR, { recursive: true });
  const next = { ...readState(), ...patch };
  writeFileSync(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

/** State the suite cannot continue without — fails loudly instead of silently skipping. */
export function requireState<K extends keyof RunState>(key: K): NonNullable<RunState[K]> {
  const value = readState()[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `run-state.${String(key)} is missing — the journey that produces it did not complete. ` +
        `Run the whole suite in order (npm run test:e2e), not this spec alone.`,
    );
  }
  return value as NonNullable<RunState[K]>;
}

/**
 * A syntactically valid SSN that is unique to `seed`.
 *
 * The system blind-indexes SSNs and raises a high-severity duplicate-SSN fraud flag when
 * two applications share one (§4.6.7) — which then blocks Preliminary Decision. A fixed
 * literal would make every run after the first collide with its own predecessor.
 */
export function uniqueSsn(seed: string): string {
  const digits = createHash("sha256").update(seed).digest("hex").replace(/\D/g, "").padEnd(12, "7");
  const area = `4${digits.slice(0, 2)}`;
  const group = digits.slice(2, 4) === "00" ? "42" : digits.slice(2, 4);
  const serial = digits.slice(4, 8) === "0000" ? "4417" : digits.slice(4, 8);
  return `${area}-${group}-${serial}`;
}

/* ------------------------------------------------------------------ *
 * TOTP
 * ------------------------------------------------------------------ */

export function totpCode(secret: string): string {
  return new OTPAuth.TOTP({
    secret: OTPAuth.Secret.fromBase32(secret.replace(/\s+/g, "")),
    digits: 6,
    period: 30,
  }).generate();
}

/** A code guaranteed to differ from `previous` — a consumed code never authenticates twice. */
export async function freshTotpCode(secret: string, previous?: string): Promise<string> {
  const deadline = Date.now() + 45_000;
  let code = totpCode(secret);
  while (previous && code === previous && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    code = totpCode(secret);
  }
  return code;
}

/* ------------------------------------------------------------------ *
 * Sign-in
 * ------------------------------------------------------------------ */

/**
 * A navigation that tolerates a superseded request. Next.js client navigations in flight
 * when a test issues its own `goto` surface as net::ERR_ABORTED; that is a race in the
 * driver, not a defect in the page, so the request is simply reissued.
 */
export async function safeGoto(page: Page, target: string): Promise<void> {
  // `domcontentloaded` rather than the default `load`: under sustained load a single slow
  // chunk keeps the load event pending long after the screen is usable, and every wait
  // that follows would then time out against a page that is actually there.
  const options = { waitUntil: "domcontentloaded" } as const;
  try {
    await page.goto(target, options);
  } catch (error) {
    if (!/ERR_ABORTED/.test(String(error))) throw error;
    await page.waitForTimeout(2000);
    await page.goto(target, options);
  }
}

/**
 * Demo quick login (§C AuthPages `demo-login-{role}`), demo mode only.
 *
 * Auth endpoints are rate-limited (10 per 15 minutes per key, §B rate limiter). A long
 * suite re-authenticates whenever a session idles out, so a refusal here is backed off
 * and retried rather than reported as a broken sign-in.
 */
export async function demoSignIn(page: Page, role: DemoRole): Promise<void> {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await safeGoto(page, "/sign-in");
    await page.getByTestId(`demo-login-${role}`).waitFor({ timeout: 120_000 });
    // The page is server-rendered; a click before hydration is dropped silently.
    await page.waitForTimeout(3000);
    await page.getByTestId(`demo-login-${role}`).click();
    try {
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    } catch (error) {
      if (attempt === attempts) {
        const message = await page
          .getByRole("alert")
          .first()
          .innerText()
          .catch(() => "");
        throw new Error(
          `demo login as ${role} never left /sign-in after ${attempts} attempts. ` +
            `Page message: ${message || "(none)"} — ${(error as Error).message.slice(0, 160)}`,
        );
      }
      await page.waitForTimeout(45_000);
    }
  }
}

/**
 * Answers the TOTP challenge, retrying with a code from the next window.
 *
 * A code is single-use and only valid for its 30-second window, so a submit that is
 * dropped before hydration — or one that races the window boundary — has to be reissued
 * with a freshly generated code rather than the same one.
 */
export async function completeMfaChallenge(page: Page, totpSecret: string): Promise<void> {
  await page.getByTestId("mfa-code-input").waitFor({ timeout: 300_000 });
  await page.waitForTimeout(2500);

  let previous: string | undefined;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const code = await freshTotpCode(totpSecret, previous);
    previous = code;
    await page.getByTestId("mfa-code-input").fill(code);
    await page.getByTestId("mfa-verify-btn").click();
    try {
      await page.waitForURL((url) => !url.pathname.startsWith("/mfa"), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      return;
    } catch (error) {
      if (attempt === 4) {
        const message = await page
          .getByRole("alert")
          .filter({ hasText: /\S/ })
          .first()
          .innerText()
          .catch(() => "");
        throw new Error(
          `the TOTP challenge was never accepted after 4 attempts. ` +
            `Page message: ${message || "(none)"} — ${(error as Error).message.slice(0, 160)}`,
        );
      }
      await page.waitForTimeout(2000);
    }
  }
}

/**
 * Signs in using the sign-in page already on screen — preserves the `redirectTo`
 * query parameter, which a fresh `goto("/sign-in")` would discard.
 */
export async function signInHere(
  page: Page,
  email: string,
  password: string,
  totpSecret?: string,
): Promise<void> {
  await page.getByTestId("signin-email").waitFor({ timeout: 300_000 });
  // Server-rendered form: a submit before hydration is dropped without any feedback.
  await page.waitForTimeout(3000);

  const attempts = 4;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await fillCredentials(page, email, password);
    await page.getByTestId("signin-submit").click();
    try {
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      break;
    } catch (error) {
      if (attempt === attempts) {
        const message = await page
          .getByRole("alert")
          .filter({ hasText: /\S/ })
          .first()
          .innerText()
          .catch(() => "");
        throw new Error(
          `sign-in as ${email} never left /sign-in after ${attempts} attempts. ` +
            `Page message: ${message || "(none)"} — ${(error as Error).message.slice(0, 160)}`,
        );
      }
      await page.waitForTimeout(20_000);
    }
  }
  if (page.url().includes("/mfa/verify") && totpSecret) {
    await completeMfaChallenge(page, totpSecret);
  }
}

/**
 * Signs in with credentials and waits to leave /sign-in, retrying with backoff.
 *
 * Sign-in is rate-limited (10 per 15 minutes per key) and the form is server-rendered, so
 * a refusal here is either a limiter window to wait out or a click that landed before
 * hydration — neither is a reason to fail the journey that follows.
 */
/**
 * Fills the sign-in form and proves the values are still there.
 *
 * /sign-in is server-rendered and hydrates late; when React mounts over the markup it
 * remounts the inputs and discards anything typed into the pre-hydration DOM. The submit
 * that follows then carries an empty form, native field validation stops it before it is
 * ever sent, and the screen reports nothing at all — the sign-in simply never happens and
 * no request reaches the server. Re-typing until the field holds what it was given is the
 * only way to know the form the click submits is the form this test filled in.
 */
async function fillCredentials(page: Page, email: string, password: string): Promise<void> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await page.getByTestId("signin-email").fill(email);
    await page.getByTestId("signin-password").fill(password);
    await page.waitForTimeout(1000);
    const [actualEmail, actualPassword] = await Promise.all([
      page.getByTestId("signin-email").inputValue(),
      page.getByTestId("signin-password").inputValue(),
    ]);
    if (actualEmail === email && actualPassword === password) return;
    await page.waitForTimeout(2000);
  }
  await expect(page.getByTestId("signin-email"), "the sign-in form keeps the address it was given").toHaveValue(
    email,
    { timeout: 60_000 },
  );
  await expect(
    page.getByTestId("signin-password"),
    "the sign-in form keeps the passphrase it was given",
  ).toHaveValue(password, { timeout: 60_000 });
}

export async function signInExpectingRedirect(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  const attempts = 5;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await safeGoto(page, "/sign-in");
    await page.getByTestId("signin-email").waitFor({ timeout: 300_000 });
    await page.waitForTimeout(3000);
    await fillCredentials(page, email, password);
    await page.getByTestId("signin-submit").click();
    try {
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      return;
    } catch (error) {
      if (attempt === attempts) {
        const message = await page
          .getByRole("alert")
          .filter({ hasText: /\S/ })
          .first()
          .innerText()
          .catch(() => "");
        throw new Error(
          `sign-in as ${email} never left /sign-in after ${attempts} attempts. ` +
            `Page message: ${message || "(none)"} — ${(error as Error).message.slice(0, 160)}`,
        );
      }
      await page.waitForTimeout(45_000);
    }
  }
}

/** Credential sign-in that carries an MFA-enrolled account through the TOTP challenge. */
export async function credentialSignIn(
  page: Page,
  email: string,
  password: string,
  totpSecret?: string,
): Promise<void> {
  await safeGoto(page, "/sign-in");
  await page.getByTestId("signin-email").waitFor({ timeout: 300_000 });
  await page.waitForTimeout(3000);
  await fillCredentials(page, email, password);
  await page.getByTestId("signin-submit").click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { waitUntil: "domcontentloaded", timeout: 180_000 });
  if (page.url().includes("/mfa/verify") && totpSecret) {
    await completeMfaChallenge(page, totpSecret);
  }
}

/**
 * Navigate as a demo role, re-authenticating if the stored session has idled out.
 * Storage states are minted once in setup; a long suite can outlive the configured
 * idle timeout, and silently landing on /sign-in would make an assertion fail for
 * the wrong reason.
 */
/**
 * True when the screen is telling the visitor their session has gone.
 *
 * An idled-out session does not always bounce to /sign-in: the shell can keep the route
 * and render an expiry notice in its place. Treating only the redirect as "signed out"
 * makes every later assertion fail against a page that was never going to load.
 */
export async function sessionExpired(page: Page): Promise<boolean> {
  const notice = page.getByRole("alert").filter({ hasText: /session has expired|sign in again/i });
  return (await notice.count()) > 0;
}

export async function gotoAs(page: Page, role: DemoRole, target: string): Promise<void> {
  await safeGoto(page, target);
  if (new URL(page.url()).pathname.startsWith("/sign-in") || (await sessionExpired(page))) {
    await demoSignIn(page, role);
    await safeGoto(page, target);
  }
}

/** Same idea for the suite's own registered borrower. */
export async function gotoAsFreshBorrower(page: Page, target: string): Promise<void> {
  await safeGoto(page, target);
  if (new URL(page.url()).pathname.startsWith("/sign-in") || (await sessionExpired(page))) {
    await credentialSignIn(page, requireState("borrowerEmail"), SUITE_PASSWORD, requireState("borrowerTotpSecret"));
    await safeGoto(page, target);
  }
}

/* ------------------------------------------------------------------ *
 * Registration (drives the real §8 pages)
 * ------------------------------------------------------------------ */

export interface RegisteredBorrower {
  email: string;
  password: string;
  verificationHref: string;
}

/** Fills and submits /sign-up. Returns the address it registered. */
export async function submitRegistration(page: Page, email: string): Promise<void> {
  await safeGoto(page, "/sign-up");
  await page.getByTestId("signup-first-name").waitFor({ timeout: 300_000 });
  // The form is server-rendered; a submit before hydration is dropped without a trace,
  // and the only visible consequence would be a verification message that never arrives.
  await page.waitForTimeout(3000);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.getByTestId("signup-first-name").fill("Journey");
    await page.getByTestId("signup-last-name").fill("Borrower");
    await page.getByTestId("signup-email").fill(email);
    await page.getByTestId("signup-password").fill(SUITE_PASSWORD);
    await page.getByTestId("signup-password-confirmation").fill(SUITE_PASSWORD);
    await page.getByTestId("signup-accept-terms").check();
    await page.getByTestId("signup-submit").click();
    try {
      // The uniform acknowledgement is the app's own proof the request was accepted.
      await page.getByTestId("signup-success").waitFor({ timeout: 90_000 });
      return;
    } catch {
      await page.waitForTimeout(5000);
    }
  }
  await expect(
    page.getByTestId("signup-success"),
    `registration for ${email} never produced the acknowledgement`,
  ).toBeVisible({ timeout: 120_000 });
}

/**
 * Reads the verification link off the Supervisor Outbound Messages page — the
 * contracted observation surface for simulated delivery (§C OutboundMessagesView).
 * `supervisorPage` must already be signed in as a Supervisor.
 */
export async function outboundVerificationHref(supervisorPage: Page, recipient: string): Promise<string> {
  await safeGoto(supervisorPage, "/supervisor/outbound");
  const row = supervisorPage.locator('[data-testid^="outbound-row-"]', { hasText: recipient }).first();
  await expect(row).toBeVisible({ timeout: 180_000 });
  const testId = await row.getAttribute("data-testid");
  const messageId = String(testId).replace("outbound-row-", "");
  await supervisorPage.getByTestId(`outbound-body-${messageId}`).click();
  await expect(supervisorPage.getByTestId(`outbound-row-${messageId}`)).toContainText("MortMortgage");
  const href = await supervisorPage.getByTestId(`outbound-verify-btn-${messageId}`).getAttribute("href");
  expect(href, "outbound message exposes a one-click verification link in demo mode").toBeTruthy();
  return String(href);
}

/** Follows the verification link and asserts the success state. */
export async function verifyEmail(page: Page, href: string): Promise<void> {
  await safeGoto(page, href);
  await page.getByTestId("verify-status-loading").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
  await expect(page.getByTestId("verify-success")).toBeVisible();
}

/**
 * Signs a verified-but-unenrolled borrower in and lands on a *ready* /mfa/enroll.
 *
 * Signing in before enrolment routes to MFA enrollment rather than the dashboard, and
 * the sign-in is what opens the enrolment window. When that window has not taken effect
 * the page holds on its "Preparing your enrollment…" notice instead of presenting the
 * secret, and signing in again reopens it. Reissuing the sign-in is the contracted
 * client behaviour, not a way to hide a failure: the route is still asserted, and a page
 * that never becomes ready still fails with its notice attached.
 */
export async function openMfaEnrollment(page: Page, email: string, password: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await signInExpectingRedirect(page, email, password);
    await page.waitForURL("**/mfa/enroll", { waitUntil: "domcontentloaded", timeout: 180_000 }).catch(() => {});
    await page.getByTestId("mfa-enroll-loading").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
    if ((await page.getByTestId("mfa-qr").count()) > 0) break;
    await page.waitForTimeout(5000);
  }

  expect(new URL(page.url()).pathname, "signing in before enrolment routes to MFA enrollment").toBe(
    "/mfa/enroll",
  );
  await expect(page.getByTestId("mfa-qr"), "the enrollment page presents its TOTP secret").toBeVisible({
    timeout: 120_000,
  });
}

/**
 * Completes TOTP enrollment from /mfa/enroll and returns the secret plus the ten
 * one-time recovery codes.
 */
export async function enrollMfa(page: Page): Promise<{ secret: string; recoveryCodes: string[] }> {
  await page.getByTestId("mfa-enroll-loading").waitFor({ state: "detached", timeout: 180_000 }).catch(() => {});
  await expect(page.getByTestId("mfa-qr")).toBeVisible();
  await page.getByTestId("mfa-secret-toggle").click();
  const secret = (await page.getByTestId("mfa-secret").innerText()).replace(/\s+/g, "");
  await page.getByTestId("mfa-code-input").fill(totpCode(secret));
  await page.getByTestId("mfa-verify-btn").click();
  await expect(page.getByTestId("recovery-codes-list")).toBeVisible({ timeout: 180_000 });
  const recoveryCodes = await page.getByTestId("recovery-code-item").allInnerTexts();
  await page.getByTestId("recovery-codes-continue").click();
  return { secret, recoveryCodes };
}

/**
 * Wait until React has hydrated the subtree the given element belongs to.
 *
 * A server-rendered screen paints its markup before the client bundle attaches
 * handlers, and the app server compiles that bundle on demand, so the gap can be
 * seconds. An action that lands in the gap is swallowed in complete silence — the
 * click raises no request, `fill()` still sets the input's value so a read-back of
 * that same input passes, and the assertion that follows waits out its whole budget
 * against an effect that was never started. React marks every host element it has
 * hydrated with its internal `__reactFiber$…` / `__reactProps$…` keys, so their
 * presence on the element is the signal that its handlers are live.
 */
export async function awaitHydrated(page: Page, testId: string, timeout = 120_000): Promise<void> {
  await page
    .waitForFunction(
      (id: string) => {
        const element = document.querySelector(`[data-testid="${id}"]`);
        if (!element) return false;
        return Object.keys(element).some(
          (key) => key.startsWith("__reactFiber$") || key.startsWith("__reactProps$"),
        );
      },
      testId,
      { timeout, polling: 250 },
    )
    // Hydration is a readiness gate, not an assertion: if the probe cannot settle we
    // fall through and let the test's own assertions report what is actually wrong.
    .catch(() => undefined);
}

/**
 * Navigate until the page's ready marker appears AND that marker is hydrated.
 *
 * The API is rate-limited by contract (§B rate limiter, 60/min on general routes)
 * and a burst of page loads inside one journey can trip it; the shell then renders
 * "This service is not available right now." rather than the screen. Backing off and
 * re-requesting is the contracted client behaviour, not a way to hide a failure —
 * a screen that never renders still fails the test with the trail attached.
 *
 * The hydration gate is part of "ready": every caller of this helper goes on to drive
 * client-side controls, and a screen whose handlers are not attached yet is not ready
 * for them (see `awaitHydrated`).
 */
export async function gotoUntilReady(
  page: Page,
  url: string,
  readyTestId: string,
  attempts = 3,
): Promise<void> {
  let lastAlert = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await safeGoto(page, url);
    try {
      await page.getByTestId(readyTestId).waitFor({ timeout: 90_000 });
      await awaitHydrated(page, readyTestId);
      return;
    } catch (error) {
      lastAlert = await page
        .getByRole("alert")
        .first()
        .innerText()
        .catch(() => "");
      if (attempt === attempts) {
        throw new Error(
          `${url} never rendered [data-testid="${readyTestId}"] after ${attempts} attempts. ` +
            `Last page alert: ${lastAlert || "(none)"} — ${(error as Error).message.slice(0, 200)}`,
        );
      }
      await page.waitForTimeout(20_000);
    }
  }
}

/**
 * Clicks a control until the element that proves the write landed appears.
 *
 * These pages are server-rendered and hydrate late under load; a click that arrives
 * before the handler is attached is dropped with no feedback at all. Reissuing the same
 * action is safe for the idempotent status writes this suite drives, and the assertion at
 * the end still fails loudly if the action genuinely does not take.
 */
export async function clickUntilVisible(
  page: Page,
  clickTestId: string,
  expectTestId: string,
  attempts = 3,
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if ((await page.getByTestId(expectTestId).count()) > 0) return;
    await page.getByTestId(clickTestId).click();
    try {
      await page.getByTestId(expectTestId).waitFor({ timeout: 90_000 });
      return;
    } catch {
      await page.waitForTimeout(3000);
    }
  }
  await expect(
    page.getByTestId(expectTestId),
    `clicking ${clickTestId} never produced ${expectTestId}`,
  ).toBeVisible({ timeout: 120_000 });
}

/* ------------------------------------------------------------------ *
 * Wizard helpers
 * ------------------------------------------------------------------ */

export const wizardStep = (page: Page, applicationId: string, step: number) =>
  page.goto(`/applications/${applicationId}?step=${step}`);

/** Waits for the auto-save indicator to settle on a saved state (§C `autosave-indicator`). */
export async function expectAutoSaved(page: Page): Promise<void> {
  await expect(page.getByTestId("autosave-indicator")).toContainText(/Saved/i, { timeout: 120_000 });
}

/** Sets a text/number input and blurs so the debounced auto-save fires. */
export async function setField(scope: Page | Locator, testId: string, value: string): Promise<void> {
  const field = scope.getByTestId(testId);
  await field.fill(value);
  await field.blur();
}

export async function setSelect(scope: Page | Locator, testId: string, value: string): Promise<void> {
  await scope.getByTestId(testId).selectOption(value);
}

/** URLA yes/no declaration and military-service controls render as a button pair. */
export async function setYesNo(scope: Page | Locator, testId: string, answer: "yes" | "no"): Promise<void> {
  await scope.getByTestId(`${testId}-${answer}`).click();
}

/** Types a prefix into an address field and picks the first suggestion (§C `address-suggest-*`). */
export async function pickAddressSuggestion(page: Page, fieldTestId: string, prefix: string): Promise<string> {
  const field = page.getByTestId(fieldTestId);
  await field.click();
  await field.press("Control+a");
  await field.pressSequentially(prefix, { delay: 90 });
  await expect(page.getByTestId("address-suggest-list")).toBeVisible({ timeout: 120_000 });
  const first = page.getByTestId("address-suggest-item-0");
  const text = await first.innerText();
  await first.click();
  await expect(page.getByTestId("address-suggest-list")).toBeHidden({ timeout: 60_000 });
  return text;
}

/* ------------------------------------------------------------------ *
 * SystemConfig (§4.6.11) through the contracted supervisor endpoints
 * ------------------------------------------------------------------ */

/** §A ConfigSetting. */
export interface ConfigSetting {
  key: string;
  value: string;
  description?: string;
  updatedByName?: string;
  updatedAt?: string;
}

/** §4.6.11 key for the non-auth request budget, and its delivered default. */
export const GENERAL_RATE_LIMIT_KEY = "rateLimit.generalPerMinute";
export const GENERAL_RATE_LIMIT_DEFAULT = "60";

/**
 * Headroom the suite runs under.
 *
 * The delivered 60-per-minute budget (§B rate limiter) is a production policy, not a
 * test-harness budget: this suite drives ten role journeys plus a 30-page axe sweep
 * through one browser from one client IP, so a single journey's page loads and writes
 * exhaust the bucket and the shell renders its unavailability notice instead of the
 * screen under test. The limit is *configurable by contract*, so the suite raises it the
 * way a Supervisor would — through PUT /api/admin/config — and restores the delivered
 * default in global teardown. The limiter itself is proved by task-046's §B suite.
 */
export const GENERAL_RATE_LIMIT_HEADROOM = "600";

/** §4.6.11 key for the auth-endpoint attempt cap, and its delivered default (§4.1.9: 10 / 15 min). */
export const AUTH_ATTEMPTS_KEY = "rateLimit.authAttempts";
export const AUTH_ATTEMPTS_DEFAULT = "10";

/**
 * Headroom for the auth limiter — the setting's declared maximum.
 *
 * Raising `rateLimit.generalPerMinute` alone is not enough. The auth endpoints run on
 * their own budget (§4.1.9: 10 attempts per `rateLimit.authWindowMinutes`, keyed by
 * account and client IP), and this suite spends that budget continuously for an hour:
 * two full registrations, two verification round-trips, MFA enrolment and challenge, the
 * demo quick login for three roles, and one more demo login every time `gotoAs` finds an
 * idled-out session. Once the budget is gone, sign-ins and the writes behind them are
 * refused and the failure surfaces as a journey that never advances — a submit that
 * leaves the file in Draft, an assignment dialog that never closes, a verification
 * message that never reaches Outbound Messages.
 *
 * The window is deliberately left at its delivered 15 minutes: widening it makes the
 * budget scarcer, not more generous. Only the cap is raised — the way a Supervisor
 * would, through PUT /api/admin/config — and it is restored in global teardown.
 */
export const AUTH_ATTEMPTS_HEADROOM = "1000";

/**
 * Every §4.6.11 setting this run raises, paired with the delivered default that global
 * teardown puts back. Setup and teardown both read this one list, so a raise cannot be
 * added without its matching restore.
 */
export const RUN_CONFIG_RAISES = [
  { key: GENERAL_RATE_LIMIT_KEY, headroom: GENERAL_RATE_LIMIT_HEADROOM, delivered: GENERAL_RATE_LIMIT_DEFAULT },
  { key: AUTH_ATTEMPTS_KEY, headroom: AUTH_ATTEMPTS_HEADROOM, delivered: AUTH_ATTEMPTS_DEFAULT },
] as const;

/**
 * Distinguishes a failure the *application* produced from one the dev server produced.
 *
 * Every contracted error this API returns is JSON — `{code, message, details, requestId}`.
 * The Next dev server, when a request lands while it is rebuilding, answers with its own
 * `/_error` HTML page and a 5xx that never reached the route handler at all. Those two are
 * not the same event and must not be treated the same way: an application 5xx is a finding
 * and fails immediately, a rebuild collision is harness noise on a dev server.
 */
function isDevServerRebuild(status: number, contentType: string, body: string): boolean {
  return status >= 500 && !contentType.includes("application/json") && /<!DOCTYPE html|<html/i.test(body);
}

/**
 * Issues a request, retrying only past the dev server's rebuild page.
 *
 * Anything the application itself answers — including a 500 with a JSON body — is returned
 * on the first attempt and left for the caller to fail on.
 */
async function requestPastRebuild(
  send: () => Promise<APIResponse>,
  what: string,
  attempts = 6,
): Promise<APIResponse> {
  let response = await send();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const contentType = response.headers()["content-type"] ?? "";
    if (!isDevServerRebuild(response.status(), contentType, await response.text())) return response;
    if (attempt === attempts) {
      throw new Error(
        `${what}: the dev server was still serving its rebuild error page after ${attempts} attempts.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
    response = await send();
  }
  return response;
}

/** Session-bound synchronizer token (SEC-3), required on every state-changing call. */
export async function csrfToken(request: APIRequestContext): Promise<string> {
  const response = await requestPastRebuild(
    () => request.get("/api/auth/session"),
    "GET /api/auth/session",
  );
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`GET /api/auth/session: expected 200 but got ${response.status()} — ${body.slice(0, 300)}`);
  }
  const session = (await response.json()) as { csrfToken?: string };
  if (!session.csrfToken) throw new Error("GET /api/auth/session returned no csrfToken");
  return session.csrfToken;
}

/** GET /api/admin/config as a supervisor, keyed by setting name. */
export async function readConfig(request: APIRequestContext): Promise<Map<string, string>> {
  const response = await requestPastRebuild(() => request.get("/api/admin/config"), "GET /api/admin/config");
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(`GET /api/admin/config: expected 200 but got ${response.status()} — ${body.slice(0, 300)}`);
  }
  const payload = (await response.json()) as { settings: ConfigSetting[] };
  return new Map(payload.settings.map((setting) => [setting.key, setting.value]));
}

/** PUT /api/admin/config. `value` is the JSON-encoded setting value (VR-125). */
export async function writeConfig(
  request: APIRequestContext,
  key: string,
  value: string,
): Promise<void> {
  const token = await csrfToken(request);
  const response = await requestPastRebuild(
    () =>
      request.put("/api/admin/config", {
        headers: { "content-type": "application/json", "x-csrf-token": token },
        data: { key, value },
      }),
    `PUT /api/admin/config ${key}`,
  );
  if (!response.ok()) {
    const body = await response.text();
    throw new Error(
      `PUT /api/admin/config ${key}=${value}: expected 200 but got ${response.status()} — ${body.slice(0, 300)}`,
    );
  }
}

/** Writes a setting and reads it back, returning the value the server reports. */
export async function setConfigAndReadBack(
  request: APIRequestContext,
  key: string,
  value: string,
): Promise<string | undefined> {
  await writeConfig(request, key, value);
  const settings = await readConfig(request);
  return settings.get(key);
}

/**
 * A Supervisor API context, signed in through the contracted demo-login endpoint.
 *
 * Used by the parts of the run that are not a journey — the configuration raise, the
 * staging seed, and the restore in global teardown — none of which should depend on a
 * storage-state file that may not exist yet (setup) or may have idled out (teardown).
 */
export async function supervisorApiContext(): Promise<APIRequestContext> {
  const context = await playwrightRequest.newContext({ baseURL: BASE_URL });
  const signIn = await context.post("/api/auth/demo-login", {
    headers: { "content-type": "application/json" },
    data: { role: "supervisor" },
  });
  if (!signIn.ok()) {
    const body = await signIn.text();
    await context.dispose();
    throw new Error(
      `POST /api/auth/demo-login as supervisor: expected 200 but got ${signIn.status()} — ${body.slice(0, 300)}`,
    );
  }
  return context;
}

/* ------------------------------------------------------------------ *
 * Demonstration data (§4.6.12)
 * ------------------------------------------------------------------ */

/** §A SeedRunInfo. */
export interface SeedRunInfo {
  id: string;
  createdAt: string;
  recordCounts: string;
  removedAt?: string;
}

/**
 * Runs a fresh demonstration seed through the contracted supervisor endpoint.
 *
 * §4.6.12 stages each demo persona in a prepared position, and several journeys start
 * from one of those positions: the FHA file awaiting Level-1 (05), the Demo Borrower's
 * Revision Requested application and its formal note (06), the Demo Caseworker's
 * unassigned queue (03, 04). Every one of those is *consumed* by the journey that uses
 * it, so a run that inherits the previous run's dataset starts from a position that no
 * longer exists. Seeding at the top of the run — "re-running the seed first removes the
 * prior seed set" (§4.6.12) — makes the suite self-sufficient on staging regardless of
 * what ran against the instance before it.
 *
 * The endpoint answers 202 with the completed run's SeedRunInfo.
 */
export async function seedDemoData(request: APIRequestContext): Promise<SeedRunInfo> {
  const token = await csrfToken(request);
  const response = await requestPastRebuild(
    () =>
      request.post("/api/admin/demo-data/seed", {
        headers: { "content-type": "application/json", "x-csrf-token": token },
        // A full §4.6.12 seed writes every entity in §9 across 600+ applications.
        timeout: 2_400_000,
      }),
    "POST /api/admin/demo-data/seed",
  );
  if (response.status() !== 202) {
    const body = await response.text();
    throw new Error(
      `POST /api/admin/demo-data/seed: expected 202 but got ${response.status()} — ${body.slice(0, 400)}`,
    );
  }
  return (await response.json()) as SeedRunInfo;
}

/* ------------------------------------------------------------------ *
 * Files
 * ------------------------------------------------------------------ */

/**
 * A structurally valid PDF. Uploads are accepted on magic-byte sniffing (SEC-12),
 * so the bytes have to actually start with the PDF header.
 */
export function pdfBuffer(label: string): Buffer {
  const body = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n% ${label}\n%%EOF\n`;
  return Buffer.from(body, "utf8");
}

/* ------------------------------------------------------------------ *
 * Accessibility
 * ------------------------------------------------------------------ */

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  targets: string[];
}

export const WCAG_AA_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

/**
 * Runs the vendored axe-core build against the current page with the WCAG 2.1 AA
 * rule set. No CDN, no API key — the engine is a local file.
 */
export async function runAxe(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ path: AXE_PATH });
  await page.waitForFunction(() => Boolean((window as unknown as { axe?: unknown }).axe), undefined, {
    timeout: 60_000,
  });
  return page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<unknown> } }).axe;
    const result = (await axe.run(document, {
      runOnly: { type: "tag", values: tags as unknown as string[] },
      resultTypes: ["violations"],
    })) as {
      violations: Array<{
        id: string;
        impact: string | null;
        help: string;
        nodes: Array<{ target: string[] }>;
      }>;
    };
    return result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.length,
      targets: violation.nodes.slice(0, 4).map((node) => node.target.join(" ")),
    }));
  }, WCAG_AA_TAGS as unknown as string[]);
}

/* ------------------------------------------------------------------ *
 * Keyboard-only driving
 * ------------------------------------------------------------------ */

/** Reads the data-testid of the element that currently holds focus. */
export const focusedTestId = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null);

/**
 * Tabs (or shift-tabs) until the element carrying `testId` holds focus. Throws with the
 * focus trail attached when the control is not reachable — an unreachable control is
 * exactly the keyboard-navigation defect this test exists to catch.
 */
export async function tabTo(page: Page, testId: string, options: { maxTabs?: number; reverse?: boolean } = {}): Promise<void> {
  // One full tab lap of the Step-10 wizard (shell nav + ten step indicators + the
  // document panel + nine review rows + the signature and submit rails) is longer
  // than 200 stops, and a control that disappears when it re-renders (the signature
  // save button, once the panel shows "Signed") drops focus to <body>, restarting the
  // lap from the top of the document. The requirement is that the control is reachable
  // with the keyboard alone, not that it is reachable within an arbitrary budget — so
  // the bound is a generous lap-and-a-half rather than a number that fails honest pages.
  const maxTabs = options.maxTabs ?? 600;
  const key = options.reverse ? "Shift+Tab" : "Tab";
  const trail: string[] = [];
  for (let index = 0; index < maxTabs; index += 1) {
    const current = await focusedTestId(page);
    if (current === testId) return;
    if (current) trail.push(current);
    await page.keyboard.press(key);
    await page.waitForTimeout(35);
  }
  const final = await focusedTestId(page);
  if (final === testId) return;
  throw new Error(
    `keyboard focus never reached [data-testid="${testId}"] within ${maxTabs} ${key} presses. ` +
      `Focus trail: ${trail.slice(-25).join(" -> ") || "(no testid-bearing elements focused)"}`,
  );
}

/** Focus a control with the keyboard and type into it — no mouse events at all. */
export async function keyboardFill(page: Page, testId: string, value: string): Promise<void> {
  await tabTo(page, testId);
  await page.keyboard.press("Control+a");
  await page.keyboard.type(value, { delay: 12 });
}

/**
 * Focus a <select> by tabbing to it and move the selection with arrow keys — the way a
 * keyboard user does it. No `selectOption`, which would set the value programmatically
 * and prove nothing about keyboard reachability.
 */
export async function keyboardSelect(page: Page, testId: string, value: string): Promise<void> {
  await tabTo(page, testId);
  const { current, target } = await page.getByTestId(testId).evaluate((element, wanted) => {
    const select = element as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    return { current: select.selectedIndex, target: values.indexOf(wanted as string) };
  }, value);
  if (target < 0) throw new Error(`[data-testid="${testId}"] has no option with value "${value}"`);

  const key = target > current ? "ArrowDown" : "ArrowUp";
  for (let step = 0; step < Math.abs(target - current); step += 1) {
    await page.keyboard.press(key);
  }
  await expect(page.getByTestId(testId)).toHaveValue(value);
}

/**
 * Types a date with the keyboard. A native date input is segmented and takes digits in
 * the browser locale's field order (MM DD YYYY here), not the ISO string a programmatic
 * fill would accept; a plain text input takes the ISO value as typed.
 */
export async function keyboardDate(page: Page, testId: string, isoDate: string): Promise<void> {
  await tabTo(page, testId);
  const isNativeDate = await page
    .getByTestId(testId)
    .evaluate((element) => (element as HTMLInputElement).type === "date");
  const [year, month, day] = isoDate.split("-");
  await page.keyboard.press("Control+a");
  await page.keyboard.type(isNativeDate ? `${month}${day}${year}` : isoDate, { delay: 40 });
  await expect(page.getByTestId(testId)).toHaveValue(isoDate);
}

/** Activate the focused control the way a keyboard user does. */
export async function keyboardActivate(page: Page, testId: string, key: "Enter" | " " = "Enter"): Promise<void> {
  await tabTo(page, testId);
  await page.keyboard.press(key === " " ? "Space" : key);
}
