"use client";

/**
 * The finished note, rendered.
 *
 * Block-level parsing is a small state machine over the lines rather than a
 * dependency: this page holds PHI, and a markdown library is a supply chain.
 * Nothing here ever reaches `dangerouslySetInnerHTML` — model output becomes
 * React nodes, so there is no path from a model to executable markup.
 */
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Note rendering                                                      */
/* ------------------------------------------------------------------ */

/**
 * Minimal Markdown renderer for the note body: headings, bold runs, and blank
 * lines. Deliberately not a full parser and never `dangerouslySetInnerHTML` —
 * this is model output shown to a clinician, so it renders as React nodes with
 * no path to injected markup. "Copy clean note" still yields raw Markdown,
 * which is what an EMR paste target wants.
 */
/**
 * Inline markdown: code, bold, italic, strikethrough, links.
 *
 * One pass, one alternation, so the pieces cannot fight each other — a naive
 * chain of `split`s turns `**a `b` c**` into nonsense. Everything is rendered
 * as React children, never as HTML, so a model cannot emit markup that runs.
 */
function inline(text: string, keyBase: string): React.ReactNode[] {
  const pattern =
    /(`[^`]+`)|(\*\*\*[^*]+\*\*\*)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(__[^_]+__)|(_[^_\n]+_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))/g;
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;

  const push = (node: React.ReactNode) => out.push(node);

  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) push(<span key={`${keyBase}-t${i++}`}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    const key = `${keyBase}-m${i++}`;

    if (tok.startsWith("`")) {
      push(
        <code
          key={key}
          className="rounded bg-[var(--border)]/50 px-1 py-0.5 font-mono text-[0.95em]"
        >
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("***")) {
      push(
        <strong key={key} className="font-semibold italic text-[var(--foreground)]">
          {tok.slice(3, -3)}
        </strong>,
      );
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      push(
        <strong key={key} className="font-semibold text-[var(--foreground)]">
          {tok.slice(2, -2)}
        </strong>,
      );
    } else if (tok.startsWith("~~")) {
      push(
        <span key={key} className="line-through decoration-[var(--muted)]">
          {tok.slice(2, -2)}
        </span>,
      );
    } else if (tok.startsWith("[")) {
      const split = tok.indexOf("](");
      const label = tok.slice(1, split);
      const href = tok.slice(split + 2, -1);
      // Only http(s). A model emitting `javascript:` is not a threat we have
      // to render.
      push(
        /^https?:\/\//i.test(href) ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-[var(--muted)] underline-offset-2 hover:text-[var(--accent)]"
          >
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    } else {
      push(
        <em key={key} className="italic">
          {tok.slice(1, -1)}
        </em>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) push(<span key={`${keyBase}-t${i++}`}>{text.slice(last)}</span>);
  return out;
}

/** A pipe-table row split into cells, with the outer pipes discarded. */
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * The finished note, rendered.
 *
 * Models emit whatever markdown they feel like — fenced blocks, pipe tables of
 * labs, nested plans, the occasional blockquote — and a renderer that only
 * knew `**bold**` showed the rest as literal asterisks and pipes in the middle
 * of a chart entry. This handles what they actually produce.
 *
 * Block-level parsing is a small state machine over the lines rather than a
 * dependency: this page holds PHI, and a markdown library is a supply chain.
 */
export function NoteBody({ markdown }: { markdown: string }) {
  const lines = markdown.split("\n");
  const blocks: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const key = `b${i}`;

    // ``` fenced code ```
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence
      blocks.push(
        <pre
          key={key}
          className="scroll-visible my-2 overflow-x-auto rounded border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-[12px] leading-relaxed"
        >
          {body.join("\n")}
        </pre>,
      );
      continue;
    }

    // | a | b |   with a |---|---| under it
    if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
      const head = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(tableCells(lines[i++]));
      }
      blocks.push(
        <div key={key} className="scroll-visible my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="border-b border-[var(--border)]">
                {head.map((c, x) => (
                  <th key={x} className="px-2 py-1 text-left font-semibold">
                    {inline(c, `${key}h${x}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, y) => (
                <tr key={y} className="border-b border-[var(--border)]/50">
                  {r.map((c, x) => (
                    <td key={x} className="px-2 py-1 align-top">
                      {inline(c, `${key}r${y}c${x}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    i++;

    if (!line.trim()) {
      blocks.push(<div key={key} className="h-2.5" />);
      continue;
    }

    // --- horizontal rule
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      blocks.push(<hr key={key} className="my-3 border-[var(--border)]" />);
      continue;
    }

    // > blockquote
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      blocks.push(
        <div
          key={key}
          className="my-1 border-l-2 border-[var(--border)] pl-3 text-[var(--muted)]"
        >
          {inline(quote[1], key)}
        </div>,
      );
      continue;
    }

    // # heading
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push(
        <h3
          key={key}
          className={cn(
            "mt-3 mb-1 font-semibold tracking-wide",
            heading[1].length <= 2
              ? "border-b border-[var(--border)] pb-1 text-[14px]"
              : "text-[13px]",
          )}
        >
          {inline(heading[2], key)}
        </h3>,
      );
      continue;
    }

    // A line that is nothing but a bold run is how most models write a
    // section header, whatever the prompt asked for.
    const boldOnly = line.trim().match(/^\*\*(.+)\*\*:?$/);
    if (boldOnly) {
      blocks.push(
        <h3
          key={key}
          className="mt-3 mb-1 border-b border-[var(--border)] pb-1 text-[13px] font-semibold tracking-wide"
        >
          {boldOnly[1]}
        </h3>,
      );
      continue;
    }

    // - bullets and 1. numbers, nested by their indentation
    const listItem = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (listItem) {
      const depth = Math.min(3, Math.floor(listItem[1].replace(/\t/g, "  ").length / 2));
      const ordered = /\d/.test(listItem[2]);
      blocks.push(
        <div key={key} className="flex gap-2" style={{ paddingLeft: `${depth * 1.1 + 0.25}rem` }}>
          <span
            className={cn(
              "select-none text-[var(--muted)]",
              ordered ? "min-w-[1.4rem] text-right" : "min-w-[0.75rem]",
            )}
          >
            {ordered ? listItem[2] : "•"}
          </span>
          <span className="min-w-0 flex-1">{inline(listItem[3], key)}</span>
        </div>,
      );
      continue;
    }

    blocks.push(
      <div key={key} className="whitespace-pre-wrap">
        {inline(line, key)}
      </div>,
    );
  }

  return <div className="font-mono text-[13px] leading-relaxed">{blocks}</div>;
}
