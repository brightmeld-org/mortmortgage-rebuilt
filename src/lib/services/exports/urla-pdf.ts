// URLA 2020 (Form 1003) PDF builder — task-041 (REQ-075, RFP §4.9.3).
//
// Renders the filled Form 1003 sections 1-9 for the primary borrower plus one
// "Additional Borrower" form per co-borrower, entirely from the shared masked
// export graph (task-040's loadApplicationExportData — LIVE-STATE rule: every
// printed value derives from loaded rows; absent data prints an em dash).
//
// Hard rules implemented here:
//   - SSN is ALWAYS masked to last four (***-**-NNNN) — this export has no
//     full-SSN mode; the loader is called with fullSsn: false and the value
//     printed is the wire ssnMasked.
//   - U.S. formats independent of server locale: hand-rolled currency
//     ($1,234,567.89) and date (MM/DD/YYYY) formatters; timestamps rendered
//     with an EXPLICIT en-US locale in the CONFIGURED company time zone
//     (INV-045 — src/lib/services/sla.ts getCompanyTimeZone(), SystemConfig
//     `company.timeZone`, default America/New_York). The zone abbreviation
//     printed after the timestamp is derived from the zone itself
//     ("ET" for America/New_York), never a hardcoded literal.
//   - Section 6 embeds the borrower's currently-valid signature image
//     (invalidatedAt null; latest signedAt wins) as an Image XObject plus the
//     attestation metadata: signer name, signature timestamp, and recorded IP.
//   - Application number in every page header; generation timestamp in every
//     page footer.
//   - Names outside WinAnsi (e.g. CJK) render with a visible "?" fallback per
//     character (src/lib/pure/pdf.ts encodeWinAnsi) — never mojibake, and the
//     file stays structurally valid (INV-036/INV-037).


import {
  PAGE_WIDTH,
  PdfDoc,
  PdfPage,
  textWidth,
  type PdfFont,
} from "@/lib/pure/pdf";
import { decodePngForPdf } from "@/lib/pure/pdf-png";
import type { ApplicationExportData, ExportBorrower } from "./application-export-data";

type SignatureRow = ApplicationExportData["signatureRows"][number];
type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Locale-independent U.S. formatters (never bare toLocaleString)
// ---------------------------------------------------------------------------

const EMPTY = "—"; // em dash (WinAnsi 0x97)

/** $1,234,567.89 — fixed grouping/decimals, independent of server locale. */
export function fmtUsCurrency(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return EMPTY;
  const negative = value < 0;
  const [intPart, frac] = Math.abs(value).toFixed(2).split(".");
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}$${grouped}.${frac}`;
}

/** ISO YYYY-MM-DD(-prefix) → MM/DD/YYYY. */
export function fmtUsDate(value: unknown): string {
  if (typeof value !== "string") return EMPTY;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!m) return value.trim().length > 0 ? value.trim() : EMPTY;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/**
 * MM/DD/YYYY hh:mm:ss AM ET — explicit en-US locale + explicit company time
 * zone; the digits are reassembled from parts so the output shape can never
 * drift with ICU defaults.
 */
export function fmtUsDateTime(value: string | Date, timeZone: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return EMPTY;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    // Generic short zone name: "ET" for America/New_York, "PT" for
    // America/Los_Angeles — derived from the configured zone (INV-045).
    timeZoneName: "shortGeneric",
  }).formatToParts(date);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  return `${p.month}/${p.day}/${p.year} ${p.hour}:${p.minute}:${p.second} ${p.dayPeriod?.toUpperCase() ?? ""} ${p.timeZoneName ?? ""}`.trim();
}

const LABEL_OVERRIDES: Record<string, string> = {
  "us-citizen": "U.S. Citizen",
  fha: "FHA",
  va: "VA",
  // HOLISTIC-REVIEW FIX: the key was "usda-rural", which is not a LoanType
  // value (the contract enum is conventional | fha | va | usda), so the
  // override never fired and USDA loans printed as "Usda" on the Form 1003.
  usda: "USDA Rural",
  hoa: "HOA",
};

/** Enum literal → human label: "primary-residence" → "Primary residence". */
function labelize(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return EMPTY;
  const override = LABEL_OVERRIDES[value];
  if (override) return override;
  const words = value.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function yesNo(value: unknown): string {
  if (value === true) return "Yes";
  if (value === false) return "No";
  return EMPTY;
}

function str(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : EMPTY;
}

function numText(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : EMPTY;
}

function rec(value: unknown): Rec | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function arr(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter((v): v is Rec => rec(v) !== null) : [];
}

function n(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addressText(value: unknown): string {
  const a = rec(value);
  if (!a) return EMPTY;
  const streetLine = [str(a.street), typeof a.unit === "string" && a.unit ? `Unit ${a.unit}` : ""]
    .filter((s) => s && s !== EMPTY)
    .join(", ");
  const cityLine = [str(a.city), str(a.state)].filter((s) => s !== EMPTY).join(", ");
  const zip = typeof a.zip === "string" ? a.zip : "";
  const joined = [streetLine, `${cityLine} ${zip}`.trim()].filter((s) => s.length > 0).join(", ");
  return joined.length > 0 ? joined : EMPTY;
}

function borrowerFullName(b: ExportBorrower): string {
  const parts = [b.firstName, b.middleName, b.lastName, b.suffix].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  return parts.length > 0 ? parts.join(" ") : "(name not provided)";
}

function last4Text(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? `****${value}` : EMPTY;
}

// ---------------------------------------------------------------------------
// Layout engine
// ---------------------------------------------------------------------------

const MX = 50;
const CW = PAGE_WIDTH - 2 * MX; // 512
const BODY_TOP = 728;
const BODY_BOTTOM = 64;

function wrapText(text: string, font: PdfFont, size: number, maxWidth: number, maxLines = 0): string[] {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line.length > 0) lines.push(line);
    line = "";
  };
  for (const word of words) {
    const candidate = line.length > 0 ? `${line} ${word}` : word;
    if (textWidth(candidate, font, size) <= maxWidth) {
      line = candidate;
      continue;
    }
    flush();
    if (textWidth(word, font, size) <= maxWidth) {
      line = word;
    } else {
      // hard-split an overlong token
      let piece = "";
      for (const ch of word) {
        if (textWidth(piece + ch, font, size) > maxWidth) {
          lines.push(piece);
          piece = ch;
        } else {
          piece += ch;
        }
      }
      line = piece;
    }
  }
  flush();
  if (lines.length === 0) lines.push("");
  if (maxLines > 0 && lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]}…`;
    return kept;
  }
  return lines;
}

class Layout {
  readonly doc = new PdfDoc();
  readonly pages: PdfPage[] = [];
  page!: PdfPage;
  y = 0;

  constructor() {
    this.newPage();
  }

  newPage(): void {
    this.page = this.doc.addPage();
    this.pages.push(this.page);
    this.y = BODY_TOP;
  }

  need(height: number): void {
    if (this.y - height < BODY_BOTTOM) this.newPage();
  }

  gap(height: number): void {
    this.y -= height;
  }

  sectionHeader(title: string): void {
    this.need(46);
    this.y -= 20;
    this.page.rect(MX, this.y - 4, CW, 16, 0.15);
    this.page.text(MX + 6, this.y, "F2", 9.5, title, { gray: 1 });
    this.y -= 12;
  }

  subHeader(title: string): void {
    this.need(30);
    this.y -= 14;
    this.page.rect(MX, this.y - 3, CW, 12, 0.9);
    this.page.text(MX + 6, this.y, "F2", 8, title);
    this.y -= 8;
  }

  /** Label-over-value cells, `columns` per row. */
  kv(pairs: [string, string][], columns = 3): void {
    for (let i = 0; i < pairs.length; i += columns) {
      const row = pairs.slice(i, i + columns);
      const colW = CW / columns;
      const cells = row.map(([label, value]) => ({
        label,
        lines: wrapText(value, "F1", 8.5, colW - 10, 3),
      }));
      const maxLines = Math.max(...cells.map((c) => c.lines.length));
      const height = 10 + maxLines * 9.5 + 4;
      this.need(height);
      const top = this.y;
      cells.forEach((cell, j) => {
        const x = MX + j * colW;
        this.page.text(x, top - 8, "F2", 6.3, cell.label.toUpperCase(), { gray: 0.4 });
        cell.lines.forEach((line, k) => {
          this.page.text(x, top - 18 - k * 9.5, "F1", 8.5, line);
        });
      });
      this.y = top - height;
    }
  }

  /** Declaration-style row: wrapped question left, bold answer right. */
  qa(question: string, answer: string): void {
    const lines = wrapText(question, "F1", 7.5, CW - 90);
    const height = lines.length * 9 + 4;
    this.need(height);
    const top = this.y;
    lines.forEach((line, k) => this.page.text(MX, top - 9 - k * 9, "F1", 7.5, line));
    const answerX = MX + CW - textWidth(answer, "F2", 8);
    this.page.text(answerX, top - 9, "F2", 8, answer);
    this.y = top - height;
  }

  para(text: string, size = 7.5, font: PdfFont = "F1", gray = 0): void {
    const lines = wrapText(text, font, size, CW - 4);
    const lineHeight = size + 2;
    for (const line of lines) {
      this.need(lineHeight + 2);
      this.y -= lineHeight;
      this.page.text(MX + 2, this.y, font, size, line, { gray });
    }
    this.y -= 2;
  }
}

// ---------------------------------------------------------------------------
// Signature selection + image preparation
// ---------------------------------------------------------------------------

interface PreparedSignature {
  row: SignatureRow;
  /** PdfDoc image resource name, when the PNG decoded successfully. */
  imageName: string | null;
  imageWidthPt: number;
  imageHeightPt: number;
}

/** Currently-valid signature for a borrower row id: invalidatedAt null, latest signedAt. */
function validSignatureFor(rows: SignatureRow[], borrowerId: string): SignatureRow | null {
  const valid = rows.filter((s) => s.borrowerId === borrowerId && s.invalidatedAt === null);
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => (a.signedAt.getTime() >= b.signedAt.getTime() ? a : b));
}

function prepareSignature(doc: PdfDoc, row: SignatureRow | null): PreparedSignature | null {
  if (!row) return null;
  let imageName: string | null = null;
  let imageWidthPt = 0;
  let imageHeightPt = 0;
  if (row.imageData && row.imageData.length > 0) {
    try {
      const decoded = decodePngForPdf(row.imageData);
      const scale = Math.min(200 / decoded.width, 54 / decoded.height, 0.75);
      imageWidthPt = decoded.width * scale;
      imageHeightPt = decoded.height * scale;
      imageName = doc.addImage(decoded);
    } catch {
      imageName = null; // unsupported PNG variant — text placeholder instead
    }
  }
  return { row, imageName, imageWidthPt, imageHeightPt };
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function renderSection1(L: Layout, b: ExportBorrower): void {
  L.sectionHeader("Section 1: Borrower Information");

  L.subHeader("1a. Personal Information");
  const alternates = Array.isArray(b.alternateNames) ? (b.alternateNames as string[]).join("; ") : EMPTY;
  const dependents =
    typeof b.dependentsCount === "number"
      ? `${b.dependentsCount}${typeof b.dependentsAges === "string" && b.dependentsAges ? ` (ages ${b.dependentsAges})` : ""}`
      : EMPTY;
  L.kv([
    ["Name (First Middle Last Suffix)", borrowerFullName(b)],
    ["Social Security Number", str(b.ssnMasked)],
    ["Date of Birth", str(b.dateOfBirthDisplay)],
    ["Citizenship", labelize(b.citizenship)],
    ["Marital Status", labelize(b.maritalStatus)],
    ["Dependents", dependents],
    ["Alternate Names", alternates],
    ["Type of Credit", labelize(b.creditType)],
    ["Email", str(b.email)],
    ["Home Phone", str(b.homePhone)],
    ["Cell Phone", str(b.cellPhone)],
    [
      "Work Phone",
      str(b.workPhone) === EMPTY
        ? EMPTY
        : `${str(b.workPhone)}${typeof b.workPhoneExt === "string" && b.workPhoneExt ? ` ext ${b.workPhoneExt}` : ""}`,
    ],
  ]);

  L.subHeader("Current Address");
  const rentSuffix =
    b.housingStatus === "rent" && typeof b.monthlyRent === "number"
      ? ` (${fmtUsCurrency(b.monthlyRent)}/month)`
      : "";
  L.kv([
    ["Address", addressText(b.currentAddress)],
    ["Housing", `${labelize(b.housingStatus)}${rentSuffix}`],
    [
      "Time at Address",
      typeof b.yearsAtAddress === "number" || typeof b.monthsAtAddress === "number"
        ? `${n(b.yearsAtAddress)} yr ${n(b.monthsAtAddress)} mo`
        : EMPTY,
    ],
  ]);
  if (rec(b.mailingAddress)) {
    L.kv([["Mailing Address (if different)", addressText(b.mailingAddress)]], 1);
  }
  for (const [i, prev] of arr(b.previousAddresses).entries()) {
    L.kv([
      [`Previous Address ${i + 1}`, addressText(prev.address)],
      ["Housing", labelize(prev.housingStatus)],
      ["Time at Address", `${n(prev.yearsAtAddress)} yr ${n(prev.monthsAtAddress)} mo`],
    ]);
  }

  L.subHeader("1b. Current Employment / Self-Employment and Income");
  L.kv([["Employment Type", labelize(b.employmentType)]], 3);
  const employments = arr(b.employments);
  if (employments.length === 0) {
    L.para("No current employment reported.");
  }
  for (const emp of employments) {
    const isSelf = emp.selfEmployed === true;
    const incomeTotal = isSelf
      ? n(emp.selfEmployedMonthlyIncome)
      : n(emp.baseMonthlyIncome) + n(emp.overtime) + n(emp.bonus) + n(emp.commission) +
        n(emp.militaryEntitlements) + n(emp.otherMonthlyIncome);
    L.kv([
      ["Employer or Business Name", str(emp.employerName)],
      ["Employer Address", addressText(emp.employerAddress)],
      ["Phone", str(emp.employerPhone)],
      ["Position or Title", str(emp.position)],
      ["Start Date", fmtUsDate(emp.startDate)],
      ["Years in Line of Work", numText(emp.yearsInLineOfWork)],
      ["Self-Employed", yesNo(emp.selfEmployed)],
      ["Ownership Share >= 25%", yesNo(emp.ownershipShareGte25)],
      ["Employed by Family / Party to Transaction", yesNo(emp.employedByFamilyOrParty)],
    ]);
    if (isSelf) {
      L.kv([
        ["Self-Employed Monthly Income (or Loss)", fmtUsCurrency(emp.selfEmployedMonthlyIncome)],
        ["Total Monthly Income", fmtUsCurrency(incomeTotal)],
      ]);
    } else {
      L.kv([
        ["Base Monthly Income", fmtUsCurrency(emp.baseMonthlyIncome)],
        ["Overtime", fmtUsCurrency(emp.overtime)],
        ["Bonus", fmtUsCurrency(emp.bonus)],
        ["Commission", fmtUsCurrency(emp.commission)],
        ["Military Entitlements", fmtUsCurrency(emp.militaryEntitlements)],
        ["Other", fmtUsCurrency(emp.otherMonthlyIncome)],
        ["Total Monthly Income", fmtUsCurrency(incomeTotal)],
      ]);
    }
  }

  const previous = arr(b.previousEmployments);
  if (previous.length > 0) {
    L.subHeader("1d. Previous Employment / Self-Employment and Income");
    for (const emp of previous) {
      L.kv([
        ["Employer or Business Name", str(emp.employerName)],
        ["Position or Title", str(emp.position)],
        ["Dates", `${fmtUsDate(emp.startDate)} - ${fmtUsDate(emp.endDate)}`],
        ["Previous Gross Monthly Income", fmtUsCurrency(emp.previousGrossMonthlyIncome)],
      ]);
    }
  }

  const otherIncome = arr(b.otherIncome);
  if (otherIncome.length > 0) {
    L.subHeader("1e. Income from Other Sources");
    for (const income of otherIncome) {
      L.kv([
        ["Income Source", labelize(income.source)],
        ["Monthly Income", fmtUsCurrency(income.monthlyAmount)],
      ]);
    }
    L.kv([
      [
        "Total Other Income (Monthly)",
        fmtUsCurrency(otherIncome.reduce((sum, r) => sum + n(r.monthlyAmount), 0)),
      ],
    ]);
  }
}

function renderSection2(L: Layout, data: Rec): void {
  L.sectionHeader("Section 2: Financial Information - Assets and Liabilities");

  L.subHeader("2a. Assets - Bank Accounts, Retirement, and Other Accounts");
  const assets = arr(data.assets);
  if (assets.length === 0) L.para("No assets reported.");
  for (const asset of assets) {
    L.kv([
      ["Account Type", labelize(asset.accountType)],
      ["Financial Institution", str(asset.financialInstitution)],
      ["Account Number", last4Text(asset.accountNumberLast4)],
      ["Cash or Market Value", fmtUsCurrency(asset.cashOrMarketValue)],
    ], 4);
  }
  if (assets.length > 0) {
    L.kv([["Total Assets", fmtUsCurrency(assets.reduce((s, a) => s + n(a.cashOrMarketValue), 0))]]);
  }

  const otherCredits = arr(data.otherCredits);
  if (otherCredits.length > 0) {
    L.subHeader("2b. Other Assets and Credits (Gifts, Grants)");
    for (const credit of otherCredits) {
      L.kv([
        ["Asset or Credit Type", labelize(credit.type)],
        ["Source or Donor", str(credit.sourceOrDonor)],
        ["Cash or Market Value", fmtUsCurrency(credit.value)],
      ]);
    }
  }

  L.subHeader("2c. Liabilities - Credit Cards, Other Debts, and Leases");
  const liabilities = arr(data.liabilities);
  if (liabilities.length === 0) L.para("No liabilities reported.");
  for (const liability of liabilities) {
    L.kv([
      ["Account Type", labelize(liability.accountType)],
      ["Company Name", str(liability.companyName)],
      ["Account Number", last4Text(liability.accountNumberLast4)],
      ["Unpaid Balance", fmtUsCurrency(liability.unpaidBalance)],
      ["Monthly Payment", fmtUsCurrency(liability.monthlyPayment)],
      ["Months Left", numText(liability.monthsLeft)],
      ["To Be Paid Off at or Before Closing", yesNo(liability.paidOffAtClosing)],
    ]);
  }

  const otherLiabilities = arr(data.otherLiabilities);
  if (otherLiabilities.length > 0) {
    L.subHeader("2d. Other Liabilities and Expenses");
    for (const liability of otherLiabilities) {
      L.kv([
        ["Type", labelize(liability.type)],
        ["Monthly Payment", fmtUsCurrency(liability.monthlyPayment)],
      ]);
    }
  }
}

function renderSection3(L: Layout, data: Rec): void {
  L.sectionHeader("Section 3: Financial Information - Real Estate");
  const reo = arr(data.realEstateOwned);
  if (reo.length === 0) {
    L.para("I do not own any real estate.");
    return;
  }
  for (const [i, property] of reo.entries()) {
    L.subHeader(`3${String.fromCharCode(97 + Math.min(i, 25))}. Property ${i + 1}`);
    L.kv([
      ["Address", addressText(property.address)],
      ["Property Value", fmtUsCurrency(property.propertyValue)],
      ["Status", labelize(property.status)],
      ["Intended Occupancy", labelize(property.intendedOccupancy)],
      ["Monthly Insurance, Taxes, HOA", fmtUsCurrency(property.monthlyInsuranceTaxesHoa)],
      ["Monthly Rental Income", fmtUsCurrency(property.monthlyRentalIncome)],
      ["Net Monthly Rental Income", fmtUsCurrency(property.netMonthlyRentalIncome)],
    ]);
    for (const [j, mortgage] of arr(property.mortgages).entries()) {
      L.kv([
        [`Mortgage ${j + 1} - Creditor`, str(mortgage.creditor)],
        ["Account Number", last4Text(mortgage.accountNumberLast4)],
        ["Monthly Payment", fmtUsCurrency(mortgage.monthlyPayment)],
        ["Unpaid Balance", fmtUsCurrency(mortgage.unpaidBalance)],
        ["Type", labelize(mortgage.mortgageType)],
        ["To Be Paid Off at or Before Closing", yesNo(mortgage.paidOffAtClosing)],
      ]);
    }
  }
}

function renderSection4(L: Layout, data: Rec): void {
  L.sectionHeader("Section 4: Loan and Property Information");
  const loan = rec(data.loan) ?? {};
  const property = rec(data.subjectProperty) ?? {};

  L.subHeader("4a. Loan and Property Information");
  const amortization =
    loan.amortizationType === "adjustable"
      ? `${labelize(loan.amortizationType)} (initial fixed ${numText(loan.armInitialFixedMonths)} mo, adjusts every ${numText(loan.armAdjustmentMonths)} mo)`
      : labelize(loan.amortizationType);
  L.kv([
    ["Loan Amount", fmtUsCurrency(loan.requestedLoanAmount)],
    ["Loan Purpose", labelize(loan.loanPurpose)],
    ["Loan Type", labelize(loan.loanType)],
    ["Loan Term (months)", numText(loan.loanTermMonths)],
    ["Amortization Type", amortization],
    ["Down Payment", fmtUsCurrency(loan.downPaymentAmount)],
    ["Down Payment Source", labelize(loan.downPaymentSource)],
  ]);
  L.kv([
    ["Property Address", addressText(property.address)],
    ["Number of Units", numText(property.numberOfUnits)],
    ["Property Value", fmtUsCurrency(property.estimatedValue)],
    ["Property Type", labelize(property.propertyType)],
    ["Occupancy", labelize(property.occupancy)],
    ["Mixed-Use Property", yesNo(property.mixedUse)],
    ["Manufactured Home", yesNo(property.manufacturedHome)],
    ["Title Will Be Held In", str(property.titleNames)],
    ["Manner of Holding Title", labelize(property.titleManner)],
    [
      "Estate",
      property.estate === "leasehold"
        ? `${labelize(property.estate)} (expires ${fmtUsDate(property.leaseholdExpirationDate)})`
        : labelize(property.estate),
    ],
    ["Target Closing Date", fmtUsDate(property.targetClosingDate)],
  ]);

  const refinance = rec(loan.refinance);
  if (refinance) {
    L.subHeader("Refinance Details");
    L.kv([
      ["Original Cost", fmtUsCurrency(refinance.originalCost)],
      ["Existing Liens", fmtUsCurrency(refinance.existingLiens)],
      ["Purpose of Refinance", labelize(refinance.purposeOfRefinance)],
    ]);
  }

  const otherMortgages = arr(loan.otherNewMortgages);
  if (otherMortgages.length > 0) {
    L.subHeader("4b. Other New Mortgage Loans on the Subject Property");
    for (const mortgage of otherMortgages) {
      L.kv([
        ["Creditor", str(mortgage.creditor)],
        ["Lien Type", labelize(mortgage.lienType)],
        ["Monthly Payment", fmtUsCurrency(mortgage.monthlyPayment)],
        ["Loan Amount", fmtUsCurrency(mortgage.amount)],
        ["Credit Limit", fmtUsCurrency(mortgage.creditLimit)],
      ]);
    }
  }

  if (typeof property.expectedMonthlyRentalIncome === "number") {
    L.subHeader("4c. Rental Income on the Property You Want to Purchase");
    L.kv([["Expected Monthly Rental Income", fmtUsCurrency(property.expectedMonthlyRentalIncome)]]);
  }

  const expense = rec(loan.proposedHousingExpense) ?? rec(data.proposedHousingExpense);
  if (expense) {
    L.subHeader("Proposed Monthly Housing Expense");
    const total =
      n(expense.firstMortgagePi) + n(expense.subordinateLiens) + n(expense.homeownersInsurance) +
      n(expense.supplementalInsurance) + n(expense.propertyTaxes) + n(expense.mortgageInsurance) +
      n(expense.hoaDues) + n(expense.other);
    L.kv([
      ["First Mortgage (P&I)", fmtUsCurrency(expense.firstMortgagePi)],
      ["Subordinate Liens (P&I)", fmtUsCurrency(expense.subordinateLiens)],
      ["Homeowner's Insurance", fmtUsCurrency(expense.homeownersInsurance)],
      ["Supplemental Insurance", fmtUsCurrency(expense.supplementalInsurance)],
      ["Property Taxes", fmtUsCurrency(expense.propertyTaxes)],
      ["Mortgage Insurance", fmtUsCurrency(expense.mortgageInsurance)],
      ["HOA Dues", fmtUsCurrency(expense.hoaDues)],
      ["Other", fmtUsCurrency(expense.other)],
      ["Total Proposed Monthly Payment", fmtUsCurrency(total)],
    ]);
  }

  L.para(
    "4d. Gifts or Grants: reported in Section 2b (Other Assets and Credits) above.",
    7,
    "F3",
    0.25,
  );
}

function renderSection5(L: Layout, b: ExportBorrower): void {
  L.sectionHeader("Section 5: Declarations");
  const d = rec(b.declarations) ?? {};

  L.subHeader("5a. About this Property and Your Money for this Loan");
  L.qa("A. Will you occupy the property as your primary residence?", yesNo(d.aOccupyPrimary));
  L.qa(
    "A.1 If YES, have you had an ownership interest in another property in the last three years?",
    yesNo(d.a1PriorOwnership),
  );
  if (d.a1PriorOwnership === true) {
    L.kv([
      ["A.1 Type of Property Owned", labelize(d.a1PropertyType)],
      ["A.1 How Title Was Held", labelize(d.a1TitleHeld)],
    ]);
  }
  L.qa(
    "B. If this is a purchase transaction, do you have a family relationship or business affiliation with the seller of the property?",
    yesNo(d.bSellerRelationship),
  );
  L.qa(
    "C. Are you borrowing any money for this real estate transaction or obtaining any money from another party that you have not disclosed on this loan application?",
    yesNo(d.cUndisclosedBorrowing),
  );
  if (d.cUndisclosedBorrowing === true) {
    L.kv([["C. Amount of This Money", fmtUsCurrency(d.cAmount)]]);
  }
  L.qa(
    "D.1 Have you or will you be applying for a mortgage loan on another property on or before closing this transaction that is not disclosed on this loan application?",
    yesNo(d.d1OtherMortgageApplication),
  );
  L.qa(
    "D.2 Have you or will you be applying for any new credit on or before closing this loan that is not disclosed on this application?",
    yesNo(d.d2NewCreditApplication),
  );
  L.qa(
    "E. Will this property be subject to a lien that could take priority over the first mortgage lien?",
    yesNo(d.ePriorityLien),
  );

  L.subHeader("5b. About Your Finances");
  L.qa("F. Are you a co-signer or guarantor on any debt or loan that is not disclosed on this application?", yesNo(d.fCosignerUndisclosed));
  L.qa("G. Are there any outstanding judgments against you?", yesNo(d.gOutstandingJudgments));
  L.qa("H. Are you currently delinquent or in default on a federal debt?", yesNo(d.hFederalDebtDelinquent));
  L.qa("I. Are you a party to a lawsuit in which you potentially have any personal financial liability?", yesNo(d.iPartyToLawsuit));
  L.qa("J. Have you conveyed title to any property in lieu of foreclosure in the past 7 years?", yesNo(d.jConveyedTitleInLieu));
  L.qa(
    "K. Within the past 7 years, have you completed a pre-foreclosure sale or short sale?",
    yesNo(d.kPreForeclosureSale),
  );
  L.qa("L. Have you had property foreclosed upon in the last 7 years?", yesNo(d.lForeclosed));
  L.qa("M. Have you declared bankruptcy within the past 7 years?", yesNo(d.mBankruptcy));
  if (d.mBankruptcy === true) {
    L.kv([["M. Bankruptcy Type", labelize(d.mBankruptcyType)]]);
  }
}

function renderSection6(
  L: Layout,
  b: ExportBorrower,
  signature: PreparedSignature | null,
  timeZone: string,
): void {
  L.sectionHeader("Section 6: Acknowledgments and Agreements");
  if (!signature) {
    L.para("No currently-valid signature is on file for this borrower.");
    return;
  }
  const row = signature.row;
  L.para(row.attestationText, 7, "F3", 0.15);
  L.gap(4);

  if (signature.imageName) {
    const boxHeight = signature.imageHeightPt + 16;
    L.need(boxHeight);
    L.y -= boxHeight;
    L.page.drawImage(signature.imageName, MX + 2, L.y + 12, signature.imageWidthPt, signature.imageHeightPt);
    L.page.line(MX, L.y + 8, MX + 240, L.y + 8, 0.3, 0.6);
    L.page.text(MX, L.y, "F1", 6.5, "Borrower Signature", { gray: 0.4 });
  } else {
    L.para("(Signature image could not be rendered; attestation metadata follows.)", 7, "F3", 0.3);
  }

  L.kv([
    ["Signed By", borrowerFullName(b)],
    ["Signature Date / Time", fmtUsDateTime(row.signedAt, timeZone)],
    ["IP Address", row.ip ?? "Not recorded"],
    ["Signature Mode", labelize(row.mode)],
    ["Attestation Version", row.attestationVersion ?? EMPTY],
  ]);
}

function renderSection7(L: Layout, b: ExportBorrower): void {
  L.sectionHeader("Section 7: Military Service");
  const ms = rec(b.militaryService);
  if (!ms || typeof ms.served !== "boolean") {
    L.qa("Did you (or your deceased spouse) ever serve, or are you currently serving, in the United States Armed Forces?", EMPTY);
    return;
  }
  L.qa(
    "Did you (or your deceased spouse) ever serve, or are you currently serving, in the United States Armed Forces?",
    yesNo(ms.served),
  );
  if (ms.served === true) {
    L.kv([
      ["Service Status", labelize(ms.status)],
      [
        "Projected Expiration of Service / Tour",
        fmtUsDate(ms.projectedExpirationDate),
      ],
    ]);
  }
}

function renderSection8(L: Layout, b: ExportBorrower): void {
  L.sectionHeader("Section 8: Demographic Information");
  const demo = rec(b.demographics);
  if (!demo) {
    L.para("Demographic information was not provided.");
    return;
  }
  const list = (value: unknown): string =>
    Array.isArray(value) && value.length > 0 ? value.map((v) => labelize(v)).join("; ") : EMPTY;
  const ethnicity =
    typeof demo.ethnicityOtherDetail === "string" && demo.ethnicityOtherDetail
      ? `${list(demo.ethnicity)} (${demo.ethnicityOtherDetail})`
      : list(demo.ethnicity);
  const race =
    Array.isArray(demo.raceOtherDetails) && demo.raceOtherDetails.length > 0
      ? `${list(demo.race)} (${(demo.raceOtherDetails as string[]).join("; ")})`
      : list(demo.race);
  L.kv([
    ["Ethnicity", ethnicity],
    ["Race", race],
    ["Sex", labelize(demo.sex)],
    ["Collection Method", typeof demo.collectionMethod === "string" ? labelize(demo.collectionMethod) : "Electronic (submitted online)"],
    ["Collected by Visual Observation or Surname", yesNo(demo.visualObservation ?? false)],
  ]);
}

function renderSection9(L: Layout): void {
  L.sectionHeader("Section 9: Loan Originator Information");
  L.para(
    "Not applicable - no loan originator organization or individual originator is associated with this application. The application was completed and submitted directly by the borrower through the online application portal.",
    7.5,
  );
}

// ---------------------------------------------------------------------------
// Header / footer + assembly
// ---------------------------------------------------------------------------

function paintHeaderFooter(
  page: PdfPage,
  pageNumber: number,
  totalPages: number,
  applicationNumber: string,
  generatedText: string,
): void {
  // Header — application number on every page (REQ-075).
  page.text(MX, 762, "F2", 10, "Uniform Residential Loan Application");
  const appLabel = `Application No. ${applicationNumber}`;
  page.text(MX + CW - textWidth(appLabel, "F2", 9), 762, "F2", 9, appLabel);
  page.text(MX, 751, "F1", 6.5, "Form 1003 (URLA 2020) - Sections 1-9", { gray: 0.4 });
  page.line(MX, 746, MX + CW, 746, 0.2, 0.8);

  // Footer — generation timestamp on every page (REQ-075).
  page.line(MX, 54, MX + CW, 54, 0.2, 0.6);
  page.text(MX, 44, "F1", 6.5, `Generated ${generatedText}`, { gray: 0.35 });
  const pageLabel = `Page ${pageNumber} of ${totalPages}`;
  page.text(MX + CW - textWidth(pageLabel, "F1", 6.5), 44, "F1", 6.5, pageLabel, { gray: 0.35 });
}

export interface UrlaPdfResult {
  bytes: Buffer;
  pageCount: number;
  /** Characters outside WinAnsi replaced with the visible "?" fallback. */
  replacedCharacters: number;
  signatureImagesEmbedded: number;
}

/**
 * Build the filled URLA 2020 PDF from the shared masked export graph.
 * `timeZone` is the company zone the caller resolved at call time (INV-045).
 */
export function buildUrlaPdf(data: ApplicationExportData, timeZone: string): UrlaPdfResult {
  const L = new Layout();
  const sectionData = data.data;
  const borrowers = [...data.borrowers].sort((a, b) => a.ordinal - b.ordinal);
  const primary = borrowers[0];
  const coBorrowers = borrowers.slice(1);
  let signatureImagesEmbedded = 0;

  const signatureFor = (b: ExportBorrower | undefined): PreparedSignature | null => {
    if (!b || typeof b.id !== "string") return null;
    const prepared = prepareSignature(L.doc, validSignatureFor(data.signatureRows, b.id));
    if (prepared?.imageName) signatureImagesEmbedded += 1;
    return prepared;
  };

  if (!primary) {
    L.para("No borrower records exist on this application.");
  } else {
    renderSection1(L, primary);
    renderSection2(L, sectionData);
    renderSection3(L, sectionData);
    renderSection4(L, sectionData);
    renderSection5(L, primary);
    renderSection6(L, primary, signatureFor(primary), timeZone);
    renderSection7(L, primary);
    renderSection8(L, primary);
    renderSection9(L);
  }

  for (const coBorrower of coBorrowers) {
    L.newPage();
    L.y -= 20;
    L.page.rect(MX, L.y - 4, CW, 18, 0.15);
    L.page.text(MX + 6, L.y + 1, "F2", 10.5, "Uniform Residential Loan Application - Additional Borrower", { gray: 1 });
    L.y -= 14;
    L.para(
      `Completed for ${borrowerFullName(coBorrower)} (Borrower ${coBorrower.ordinal}). Assets, liabilities, real estate, and loan and property information for all borrowers are reported on the primary borrower's form (Sections 2-4).`,
      7,
      "F3",
      0.25,
    );
    renderSection1(L, coBorrower);
    renderSection5(L, coBorrower);
    renderSection6(L, coBorrower, signatureFor(coBorrower), timeZone);
    renderSection7(L, coBorrower);
    renderSection8(L, coBorrower);
  }

  const generatedText = fmtUsDateTime(data.generatedAt, timeZone);
  const totalPages = L.pages.length;
  L.pages.forEach((page, i) => {
    paintHeaderFooter(page, i + 1, totalPages, data.application.applicationNumber, generatedText);
  });

  return {
    bytes: L.doc.render(),
    pageCount: totalPages,
    replacedCharacters: L.doc.replacedCount,
    signatureImagesEmbedded,
  };
}
