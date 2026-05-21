import { useState, useCallback } from "react";
import { Copy, Check, Code2, Sparkles } from "lucide-react";

/* ─────────────────────────────────────────────
   CodeBlock — fenced code with copy button
   ───────────────────────────────────────────── */
export function CodeBlock({ language, children }: { language?: string; children: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    navigator.clipboard.writeText(children).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [children]);

  const displayLang = language || "text";

  return (
    <div className="chat-code-block my-4 border border-border/40">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.03] px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-white/50">
          <Code2 className="h-3.5 w-3.5" />
          <span className="font-mono">{displayLang}</span>
        </div>
        <button
          onClick={copy}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-white/50 transition-all hover:bg-white/10 hover:text-white/80"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-emerald-400" />
              <span className="text-emerald-400 font-medium">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3" />
              <span>Copy</span>
            </>
          )}
        </button>
      </div>
      {/* Code content */}
      <pre className="overflow-x-auto p-4 text-[0.8125rem] leading-relaxed">
        <code className="font-mono text-white/90">{children}</code>
      </pre>
    </div>
  );
}

/* ─────────────────────────────────────────────
   Markdown Components Map
   ───────────────────────────────────────────── */
export const markdownComponents = {
  // Code blocks — fenced vs inline
  code: ({ className, children, ...props }: any) => {
    const match = /language-(\w+)/.exec(className || "");
    const content = String(children).replace(/\n$/, "");

    // If it has a language class or contains newlines, treat as block
    if (match || content.includes("\n")) {
      return <CodeBlock language={match?.[1]}>{content}</CodeBlock>;
    }

    // Inline code
    return (
      <code
        className="rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[0.8125rem] text-primary dark:bg-primary/15"
        {...props}
      >
        {children}
      </code>
    );
  },

  // Headings with prominent styling & sizing
  h1: ({ children, ...props }: any) => (
    <h1
      className="mb-4 mt-6 border-l-4 border-primary pl-3 font-display text-2xl font-bold tracking-tight text-foreground first:mt-0"
      {...props}
    >
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: any) => (
    <h2
      className="mb-3 mt-5 border-l-4 border-gold pl-3 font-display text-xl font-bold tracking-tight text-foreground first:mt-0"
      {...props}
    >
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: any) => (
    <h3
      className="mb-2 mt-4 font-display text-lg font-semibold tracking-tight text-foreground first:mt-0"
      {...props}
    >
      {children}
    </h3>
  ),
  h4: ({ children, ...props }: any) => (
    <h4
      className="mb-2 mt-3 font-display text-sm font-semibold uppercase tracking-wider text-muted-foreground first:mt-0"
      {...props}
    >
      {children}
    </h4>
  ),

  // Paragraphs
  p: ({ children, ...props }: any) => (
    <p className="mb-4 leading-relaxed text-foreground/90 last:mb-0" {...props}>
      {children}
    </p>
  ),

  // Lists
  ul: ({ children, ...props }: any) => (
    <ul className="mb-4 ml-1 space-y-2 last:mb-0" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: any) => (
    <ol className="mb-4 ml-1 list-decimal space-y-2 pl-5 last:mb-0 marker:text-primary/70 marker:font-bold" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: any) => {
    // Check if parent is ol (ordered) — add custom bullet if unordered
    const isOrdered = props.node?.parentNode?.tagName === "ol";
    return (
      <li
        className={`leading-relaxed ${!isOrdered ? "flex items-start gap-2" : ""}`}
        {...props}
      >
        {!isOrdered && (
          <span className="mt-2.5 block h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60" />
        )}
        <span className="flex-1">{children}</span>
      </li>
    );
  },

  // Blockquotes
  blockquote: ({ children, ...props }: any) => (
    <blockquote
      className="my-4 rounded-r-lg border-l-4 border-primary/40 bg-primary/5 py-2 pl-4 pr-3 text-[0.925rem] italic text-foreground/80 dark:bg-primary/10"
      {...props}
    >
      {children}
    </blockquote>
  ),

  // Links
  a: ({ children, href, ...props }: any) => {
    if (href?.startsWith("/exams/")) {
      return (
        <a
          href={href}
          className="mt-3 mb-1 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 shadow-sm transition-all"
        >
          <Sparkles className="h-4 w-4" />
          {children}
        </a>
      );
    }
    return (
      <a
        href={href}
        className="font-medium text-primary underline decoration-primary/30 underline-offset-2 transition-colors hover:decoration-primary/70"
        target="_blank"
        rel="noopener noreferrer"
        {...props}
      >
        {children}
      </a>
    );
  },

  // Horizontal rule
  hr: () => (
    <div className="my-6 flex items-center gap-3">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-transparent" />
      <Sparkles className="h-3 w-3 text-primary/30" />
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-border to-transparent" />
    </div>
  ),

  // Strong / emphasis
  strong: ({ children, ...props }: any) => (
    <strong className="font-bold text-foreground" {...props}>
      {children}
    </strong>
  ),

  // Tables
  table: ({ ...props }: any) => (
    <div className="my-5 overflow-x-auto rounded-xl border bg-card/50 shadow-sm">
      <table className="m-0 w-full text-sm" {...props} />
    </div>
  ),
  thead: ({ ...props }: any) => (
    <thead className="bg-muted/40" {...props} />
  ),
  th: ({ ...props }: any) => (
    <th
      className="border-b bg-muted/50 px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap"
      {...props}
    />
  ),
  td: ({ ...props }: any) => (
    <td className="border-b border-border/40 px-4 py-3 transition-colors" {...props} />
  ),
  tr: ({ ...props }: any) => (
    <tr className="transition-colors hover:bg-muted/20" {...props} />
  ),

  // Pre — wrapper handled by CodeBlock, but just in case
  pre: ({ children, ...props }: any) => (
    <div {...props}>{children}</div>
  ),
};
