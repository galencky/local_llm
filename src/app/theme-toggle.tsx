"use client";

import { useSyncExternalStore } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { cn } from "@/lib/utils";

type Theme = "light" | "dark" | "system";

const ORDER: Theme[] = ["light", "dark", "system"];
const ICON = { light: Sun, dark: Moon, system: Monitor } as const;
const LABEL = { light: "Light", dark: "Dark", system: "Follow system" } as const;

/**
 * The theme lives in the DOM (`<html data-theme>`), not in React state — the
 * inline script in the layout sets it before first paint, so React is a
 * subscriber here rather than the owner. `useSyncExternalStore` is the right
 * shape for that and avoids both a hydration mismatch and a render-time read
 * of localStorage.
 */
const listeners = new Set<() => void>();

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" ? attr : "system";
}

/** The server cannot know the viewer's choice; "system" is the honest default. */
function getServerSnapshot(): Theme {
  return "system";
}

function apply(next: Theme) {
  const root = document.documentElement;
  if (next === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", next);
  try {
    localStorage.setItem("airlock-theme", next);
  } catch {
    /* private window: the choice simply will not persist */
  }
  listeners.forEach((fn) => fn());
}

/**
 * Three-state theme control. "System" is a real state, not the absence of a
 * choice — a ward monitor that dims at dusk should keep doing so unless
 * someone says otherwise.
 */
export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  return (
    <div
      role="group"
      aria-label="Colour theme"
      className="flex shrink-0 items-center rounded-full border border-[var(--border)] p-0.5"
    >
      {ORDER.map((t) => {
        const Icon = ICON[t];
        const active = theme === t;
        return (
          <button
            key={t}
            onClick={() => apply(t)}
            title={LABEL[t]}
            aria-label={LABEL[t]}
            aria-pressed={active}
            className={cn(
              "rounded-full p-1 transition-colors",
              active
                ? "bg-[var(--accent)]/12 text-[var(--accent)]"
                : "text-[var(--faint)] hover:text-[var(--foreground)]",
            )}
          >
            <Icon className="size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
