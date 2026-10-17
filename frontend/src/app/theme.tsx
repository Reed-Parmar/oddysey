/** Light/dark theme: follows the system until the user picks one; the choice is stored per browser. */
import { Moon, Sun } from "@phosphor-icons/react";
import { useState } from "react";

const KEY = "spa-theme";

function systemDark() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches;
}

function currentTheme(): "light" | "dark" {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return systemDark() ? "dark" : "light";
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState(currentTheme);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className={`inline-flex size-10 items-center justify-center rounded-lg text-neutral transition-colors hover:bg-neutral-bg hover:text-text ${className}`}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(KEY, next);
        } catch {
          /* storage unavailable: the choice lasts for this page only */
        }
        setTheme(next);
      }}
    >
      {theme === "dark" ? <Sun aria-hidden size={20} /> : <Moon aria-hidden size={20} />}
    </button>
  );
}
