# MortMortgage — Rebuilt

A mortgage origination platform built by [BrightMeld](https://brightmeld.com)'s contract-governed AI pipeline from a single RFP: 109 API endpoints, a 15-state underwriting workflow with a 40-transition matrix, full URLA 2020 / MISMO v3.4 / HMDA compliance surfaces, and a complete contract, review and quality-gate record behind every line.

**Contract-Governed AI: Built to be changed.**

---

## The story: this app has been built twice

**Act 1 — the initial build.** In February 2026, one developer built [the first version of this application](https://github.com/MarcEpsteinMyExposome/mortmortgage-initial-build) with Claude Code: 24 tasks and 377 passing tests over 8 working days. Fast, and it worked. But it wasn't *delivered* in the engineering sense: no contract, no adversarial review, no independent-of-the-builder quality gate, integrations unverified.

**Act 2 — the reckoning.** That gap — fast is not the same as delivered — is what started BrightMeld's contract-governed pipeline. Its first commit came nineteen days after the initial build began.

**Act 3 — this repository.** The same application, rebuilt end-to-end by that pipeline from a single 128 KB RFP (included here as [`MortMortgage-RFP-v1.0.md`](./MortMortgage-RFP-v1.0.md)). Because we had already built this domain by hand, we could judge whether the rebuild was actually better — not guess.

## The numbers

| Metric | Value |
|---|---|
| Wall-clock, RFP → final quality-gate pass | **105.5 hours** (4.4 days), almost entirely unattended |
| The pipeline's own human-team estimate for the same scope | 640 hours / 16 weeks |
| Modeled build cost | $655.85 across 95 AI agent spawns |
| Scale | 48 tasks · 30 components · 12 increments · 109 endpoints · 15-state workflow, 40-transition matrix |
| Tests | 368/368 unit + integration (`task-046/`) · 87/87 end-to-end (`task-047/`) |
| Contract | revision 23 — every change carries finding IDs and a content hash |
| Final quality gate | score 100/100, zero blocking findings, delivery-ready |

## The part we lead with: the gates failed first

A showcase that only shows the win is less credible than one that shows the gates working. The final quality gate **failed twice before passing** — 0/100, then 60/100, then 100/100:

- The first failure caught a **live authentication bypass** (an unverified-email account receiving a full MFA-free session) that 242 passing tests and an 87-test browser suite had missed.
- Adversarial review found a **live account-takeover vector** and a fabricated regulatory disclosure — 55 findings in all, every one closed with contract provenance.
- The final increment's test-writer audited the previous eleven and found **6 real defects** in code that had already passed every per-increment gate.
- Mid-build, a code generator **refused to restructure correct code** to satisfy a broken checker, and escalated instead. The tool got fixed; the code didn't get worse.

Every fix landed as a contract change with finding IDs — not a hand-patch.

## What's deliberately not in this repository

Code comments here cite identifiers like `REQ-062`, `INV-048`, `XBR-014`, and sections of a build plan and contract. Those documents exist — a ~945-field contract at revision 23, a build plan, an assessment, a verification tree of over 1,000 evidence files, and the full adversarial-review, exercise, and quality-gate reports. They are **withheld by design, not missing by accident**: the methodology that produces them is BrightMeld's product, and the complete artifact set is what a client receives with their engagement. We show it live. The identifiers are left in the code because traceability from any line back to its requirement is the point.

The withholding has one visible consequence: the unit/integration suite (`task-046/`) enumerates its route lists, transition matrices, and masking rules from `contracts.json` rather than from hand-maintained arrays — so in this repository it exits immediately, and CI here runs the full stack (migrate from empty, seed, build, serve) plus the 87-test end-to-end suite instead. The contract-driven suite's result of record at delivery: 368/368. It has since grown to 465/465 through three post-delivery contract-governed changes.

## Running it

Full instructions: [`task-048/README.md`](./task-048/README.md) (the delivered system documentation).

```bash
npm ci
cp .env.example .env   # fill in DATABASE_URL + generate the 3 crypto keys (instructions inside)
npm run db:setup       # migrations + demo seed
npm run dev            # http://localhost:3083
npm run worker         # background jobs, in a second terminal
```

Or the full stack with Docker Compose (PostgreSQL + S3 emulator): `docker compose up -d --build`, then `docker compose exec worker npm run db:setup` → http://localhost:3085.

**Demo access:** with `DEMO_MODE=true`, the sign-in page offers one-click demo logins for Borrower, Caseworker, and Supervisor roles. Demo identities use reserved `.example` domains and receive random hashed passwords at seed time — there are no credentials in this codebase.

## Documentation

The delivered documentation set is in [`task-048/`](./task-048/): user guide, deployment runbook (AWS + Docker), IdP wiring, the complete URLA→MISMO field mapping (167 entries), HMDA code tables, simulation mappings, and 12+ executable demo walkthroughs.

## License

Source-available for evaluation and reading. All rights reserved — this is a showcase of a delivered engagement, not an open-source product.

---

*Built by BrightMeld's pipeline, 2026. The initial hand-built version is preserved unchanged at [mortmortgage-initial-build](https://github.com/MarcEpsteinMyExposome/mortmortgage-initial-build).*
