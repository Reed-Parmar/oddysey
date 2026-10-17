/** Student form controls shared by onboarding and the dashboard profile form. */
import { Check, WarningCircle, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { ErrorState, Skeleton } from "@/components/shared";
import { Button, Input, cx } from "@/components/ui";

import { SKILL_MAX, TRADE_MAX, normaliseSkills, skillAddError } from "./forms";
import { useTrades } from "./hooks";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Multi-input with SKL-01 suggestions (native datalist); free names are allowed. */
export function SkillsInput({ id = "skills", value, onChange, error }: {
  id?: string; value: string[]; onChange: (v: string[]) => void; error?: string;
}) {
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const listId = useId();
  const hintId = `${id}-hint`;
  const q = useDebounced(draft.trim());
  const suggestions = useQuery({
    queryKey: qk.skills.list(q || undefined),
    queryFn: () => call(api.GET("/api/v1/skills", { params: { query: q ? { q } : {} } })),
    enabled: q.length >= 1 && q.length <= 100,
    staleTime: 60_000,
  });
  const taken = new Set(value.map((s) => s.toLowerCase()));
  const options = (suggestions.data?.data ?? []).filter((s) => !taken.has(s.name.toLowerCase())).slice(0, 15);

  const add = () => {
    const err = skillAddError(value, draft);
    if (err) {
      setLocalError(draft.trim() ? err : null);
      return;
    }
    onChange(normaliseSkills([...value, draft]));
    setDraft("");
    setLocalError(null);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Your skills">
          {value.map((s) => (
            <li key={s.toLowerCase()} className="inline-flex max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary-soft py-0.5 pr-0.5 pl-3 text-sm font-medium text-primary-ink">
              <span className="min-w-0 [overflow-wrap:anywhere]">{s}</span>
              <button
                type="button"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-primary/15"
                aria-label={`Remove ${s}`}
                onClick={() => onChange(value.filter((x) => x !== s))}
              >
                <X aria-hidden size={12} weight="bold" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-border-strong px-3 py-2 text-sm text-muted">No skills listed yet.</p>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          list={listId}
          value={draft}
          maxLength={120}
          placeholder="Type a skill, e.g. Soldering"
          aria-describedby={hintId}
          aria-invalid={!!(localError || error) || undefined}
          disabled={value.length >= SKILL_MAX}
          onChange={(e) => {
            setDraft(e.target.value);
            setLocalError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" onClick={add} disabled={!draft.trim() || value.length >= SKILL_MAX}>
          Add
        </Button>
      </div>
      <datalist id={listId}>
        {options.map((s) => (
          <option key={s.id} value={s.name} />
        ))}
      </datalist>
      <p id={hintId} className="text-xs text-muted">
        {value.length} / {SKILL_MAX} skills. Press Enter to add; pick a suggestion or type your own.
      </p>
      {(localError || error) && (
        <p className="flex items-center gap-1 text-xs font-medium text-danger" role="alert">
          <WarningCircle aria-hidden size={14} className="shrink-0" />
          {localError || error}
        </p>
      )}
    </div>
  );
}

/** ITI trade multi-select as checkbox chips (1–5). A fieldset/legend pair keeps it one labelled group. */
export function TradePicker({ value, onChange, error, legend = "ITI trades — select all that apply", required }: {
  value: string[]; onChange: (v: string[]) => void; error?: string; legend?: string; required?: boolean;
}) {
  const trades = useTrades();
  const hintId = useId();
  const chosen = new Set(value);
  const full = value.length >= TRADE_MAX;
  const toggle = (id: string) => onChange(chosen.has(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={hintId}>
      <legend className="mb-1.5 text-sm font-semibold text-text">
        {legend} {required && <span className="text-danger" aria-hidden>*</span>}
      </legend>
      {trades.isLoading ? (
        <div className="flex flex-wrap gap-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9 w-28 rounded-full" />)}</div>
      ) : trades.error ? (
        <ErrorState error={trades.error} onRetry={() => void trades.refetch()} />
      ) : !trades.data?.data.length ? (
        <p className="text-sm text-muted">No trades are configured yet. Ask your programme team.</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {trades.data.data.map((t) => {
            const on = chosen.has(t.id);
            const disabled = !on && full;
            return (
              <li key={t.id}>
                <label
                  className={cx(
                    "inline-flex min-h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-primary/40",
                    on ? "border-primary bg-primary-soft text-primary-ink" : "border-border-strong bg-surface text-text hover:border-primary",
                    disabled && "cursor-not-allowed opacity-50 hover:border-border-strong",
                  )}
                >
                  <input type="checkbox" className="sr-only" checked={on} disabled={disabled} onChange={() => toggle(t.id)} />
                  {on && <Check aria-hidden size={12} weight="bold" />}
                  {t.name}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <p id={hintId} className="text-xs text-muted">{value.length} of up to {TRADE_MAX} selected.</p>
      {error && (
        <p className="flex items-center gap-1 text-xs font-medium text-danger" role="alert">
          <WarningCircle aria-hidden size={14} className="shrink-0" />
          {error}
        </p>
      )}
    </fieldset>
  );
}
