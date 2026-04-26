/**
 * Strip common LaTeX commands from a string so it renders as plain text in
 * the UI. Applied to issue claims, evidence, and suggested actions that come
 * back from the Fix Agent with raw LaTeX source.
 */
export function stripLatex(s: string): string {
  if (!s) return "";
  return s
    .replace(/\\&/g, "&")
    .replace(/---/g, "—")
    .replace(/--/g, "–")
    .replace(/\\%/g, "%")
    .replace(/\\\$/g, "$")
    .replace(/\\,/g, " ")          // thin space
    .replace(/\\textbf\{([^}]*)\}/g, "$1")
    .replace(/\\textit\{([^}]*)\}/g, "$1")
    .replace(/\\emph\{([^}]*)\}/g, "$1")
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/\\cite\{[^}]*\}/g, "[ref]")
    .replace(/\\ref\{[^}]*\}/g, "")
    .replace(/\\label\{[^}]*\}/g, "")
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, "$1") // generic \cmd{...} → inner text
    .replace(/\$\$([^$]*)\$\$/g, (_, m) => m.trim())  // display math
    .replace(/\$([^$]*)\$/g, (_, m) => m.trim())       // inline math
    .replace(/\{([^{}]*)\}/g, "$1")     // remaining bare braces
    .replace(/\s{2,}/g, " ")
    .trim();
}
