"use client";

// UrlaWizard (task-016) — address field group with type-ahead autocomplete on
// the street input (§4.2.11 / REQ-040). Selecting a suggestion fills street,
// unit, city, state, ZIP, county. Suggestions are keyboard navigable
// (ArrowUp/Down + Enter, Escape) and screen-reader announced (combobox/listbox
// ARIA). Service failure or the `!!` fault trigger degrades SILENTLY to manual
// entry — no error dialog.

import { useEffect, useId, useRef, useState } from "react";
import { suggestAddresses } from "./api";
import { inputClass } from "./fields";
import { testIdForPath } from "./format";
import type { Address, AddressSuggestion } from "./types";

export function AddressGroup({
  basePath,
  label,
  required,
  value,
  onChange,
  disabled,
  errorFor,
  showCountry,
  showCounty = true,
}: {
  basePath: string;
  label?: string;
  required?: boolean;
  value: Address | undefined;
  onChange: (next: Address) => void;
  disabled?: boolean;
  /** Inline error lookup by section-relative field path. */
  errorFor?: (path: string) => string | undefined;
  showCountry?: boolean;
  showCounty?: boolean;
}) {
  const addr: Address = value ?? { street: "", city: "", state: "", zip: "" };
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const set = (patch: Partial<Address>) => onChange({ ...addr, ...patch });

  const queryFor = (street: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = street.trim();
    if (q.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      const seq = ++seqRef.current;
      const rows = await suggestAddresses(q);
      if (seq !== seqRef.current) return; // stale response
      setSuggestions(rows);
      setActiveIndex(rows.length > 0 ? 0 : -1);
      setOpen(rows.length > 0); // empty result => silent manual fallback
    }, 250);
  };

  const pick = (s: AddressSuggestion) => {
    onChange({
      ...addr,
      street: s.street,
      unit: s.unit ?? addr.unit,
      city: s.city,
      state: s.state,
      zip: s.zip,
      county: s.county ?? addr.county,
    });
    setOpen(false);
    setSuggestions([]);
  };

  // Close on outside click.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  const err = (suffix: string) => errorFor?.(`${basePath}.${suffix}`) ?? errorFor?.(basePath);
  const fieldId = (suffix: string) => testIdForPath(`${basePath}.${suffix}`);

  const sub = (
    suffix: keyof Address,
    fieldLabel: string,
    span: string,
    fieldRequired?: boolean,
    placeholder?: string,
  ) => (
    <div className={span}>
      <label className="mb-1 block text-[13px] font-semibold text-ink">
        {fieldLabel}
        {fieldRequired ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        data-testid={fieldId(suffix)}
        type="text"
        value={(addr[suffix] as string | undefined) ?? ""}
        onChange={(e) => set({ [suffix]: e.target.value } as Partial<Address>)}
        placeholder={placeholder}
        disabled={disabled}
        className={inputClass}
      />
    </div>
  );

  const streetError = err("street");

  return (
    <div ref={rootRef}>
      {label ? (
        <p className="mb-2 text-[13px] font-semibold uppercase tracking-wide text-ink-soft">
          {label}
          {required ? <span aria-hidden="true"> *</span> : null}
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-6">
        <div className="relative sm:col-span-4">
          <label className="mb-1 block text-[13px] font-semibold text-ink">
            Street
            {required ? <span aria-hidden="true"> *</span> : null}
          </label>
          <input
            data-testid={fieldId("street")}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && activeIndex >= 0 ? `${listId}-opt-${activeIndex}` : undefined}
            value={addr.street ?? ""}
            onChange={(e) => {
              set({ street: e.target.value });
              queryFor(e.target.value);
            }}
            onKeyDown={(e) => {
              if (!open || suggestions.length === 0) return;
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) => (i + 1) % suggestions.length);
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) => (i - 1 + suggestions.length) % suggestions.length);
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (activeIndex >= 0) pick(suggestions[activeIndex]);
              } else if (e.key === "Escape") {
                setOpen(false);
              }
            }}
            placeholder="Start typing an address…"
            disabled={disabled}
            // NFR-025 / LENS-014: same omission as YesNoField — the error <p>
            // below had no id, so the message was never announced.
            aria-invalid={streetError ? true : undefined}
            aria-describedby={streetError ? `${listId}-err` : undefined}
            className={`${inputClass} ${streetError ? "border-danger" : ""}`}
          />
          {streetError ? (
            <p id={`${listId}-err`} role="alert" className="mt-1 text-xs text-danger">
              {streetError}
            </p>
          ) : null}
          {open ? (
            <ul
              id={listId}
              data-testid="address-suggest-list"
              role="listbox"
              aria-label="Address suggestions"
              className="absolute z-30 mt-1 max-h-64 w-full overflow-auto rounded-md border border-line bg-card py-1 shadow-lg"
            >
              {suggestions.map((s, i) => (
                <li
                  key={`${s.formatted}-${i}`}
                  id={`${listId}-opt-${i}`}
                  data-testid={`address-suggest-item-${i}`}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={`cursor-pointer px-3 py-2 text-sm ${
                    i === activeIndex ? "bg-copper-soft text-ink" : "text-ink-soft"
                  }`}
                >
                  {s.formatted}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {sub("unit", "Unit", "sm:col-span-2")}
        {sub("city", "City", "sm:col-span-2", required)}
        {sub("state", "State", "sm:col-span-1", required)}
        {sub("zip", "ZIP", "sm:col-span-1", required)}
        {showCounty ? sub("county", "County", "sm:col-span-1") : null}
        {showCountry ? sub("country", "Country", "sm:col-span-1") : null}
      </div>
    </div>
  );
}
