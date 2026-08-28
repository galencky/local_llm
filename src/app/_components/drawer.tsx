"use client";

import { useEffect, useRef } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Everything a drawer has to do besides render.
 *
 * Seven drawers open over this page and every one of them was missing the
 * same four things: Escape did nothing, focus stayed on the button behind the
 * overlay, Tab walked through the thirty controls underneath it, and the page
 * scrolled when you turned the wheel over a drawer that had already reached
 * its own end. Measured at 1024x600, a wheel gesture over an open drawer moved
 * the page behind it 342px.
 *
 * Returns a ref for the drawer's own element. Attach it and pass
 * `role="dialog" aria-modal="true"`, which the callers do.
 */
export function useDrawer(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  // Held in a ref so the effect runs once per open, not on every parent
  // render — re-running it would yank focus back to the top mid-typing.
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const focusable = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((el) => el.offsetParent !== null);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      // Keep Tab inside the drawer rather than walking the page behind it.
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !ref.current?.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // The close button is first in every drawer's markup and is a safe, quiet
    // landing place — it does not read a whole panel of text at the reader.
    focusable()[0]?.focus();

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      // Put the keyboard back where it was, or the next Tab starts from the
      // top of the document.
      opener?.focus?.();
    };
  }, []);

  return ref;
}

/**
 * The shell every drawer had written out for itself.
 *
 * Seven of them repeated the same twenty lines — scrim, positioned `aside`,
 * the three ARIA attributes, the header row, the close button — and the
 * repetition was not free: `useDrawer`'s four behaviours had to be wired up by
 * hand each time, so "add a drawer" meant "remember four things", and a drawer
 * that forgot one looked fine until someone pressed Escape. One shell, and
 * they cannot diverge.
 */
export function Drawer({
  title,
  subtitle,
  label,
  width = "xl",
  onClose,
  toolbar,
  children,
}: {
  title: string;
  /** The line under the title. Optional — the inspector wants two, some want none. */
  subtitle?: React.ReactNode;
  /** Accessible name. Defaults to the title, which is usually right. */
  label?: string;
  width?: "xl" | "2xl" | "3xl";
  onClose: () => void;
  /** An extra row under the header, e.g. the Prompts drawer's tabs. */
  toolbar?: React.ReactNode;
  children: React.ReactNode;
}) {
  const ref = useDrawer(onClose);
  const max = { xl: "max-w-xl", "2xl": "max-w-2xl", "3xl": "max-w-3xl" }[width];

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="drawer-scrim absolute inset-0 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={label ?? title}
        tabIndex={-1}
        className={cn(
          "drawer-panel relative flex h-full w-full flex-col border-l border-[var(--border)] bg-[var(--surface)] shadow-2xl",
          max,
        )}
      >
        <div className="flex items-start justify-between border-b border-[var(--border)] px-4 py-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">{title}</h3>
            {subtitle && <p className="mt-0.5 text-[11px] text-[var(--muted)]">{subtitle}</p>}
          </div>
          {/* First in the markup on purpose: `useDrawer` focuses the first
              focusable element on open, and a close button is a quieter
              landing place than reading a whole panel at a screen reader. */}
          <button
            onClick={onClose}
            className="shrink-0 rounded p-1 text-[var(--muted)] hover:text-[var(--foreground)]"
            aria-label={`Close ${label ?? title}`}
          >
            <ChevronRight className="size-5" />
          </button>
        </div>
        {toolbar}
        {children}
      </aside>
    </div>
  );
}

/** A drawer's scrolling body. Every one of them wants exactly this. */
export function DrawerBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("scroll-visible flex-1 overflow-auto", className)}>{children}</div>
  );
}
