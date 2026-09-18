import React from "react";
import { getLocale } from "./locale.js";
import { splitTemplate, templateIn } from "./translate.js";

/**
 * A translated sentence that contains MARKUP or React nodes.
 *
 * `t()` returns a string, which is enough for almost everything. It is not
 * enough for a sentence like "only {units} units left until {deadline}" where
 * the number is bold: splitting that into three JSX fragments would freeze the
 * Hebrew word order into the English sentence. `Tx` keeps the sentence whole —
 * one key, one translator decision — and substitutes the nodes wherever the
 * target language puts them.
 *
 *   <Tx k="deal.units_to_target" vars={{ units: <b>{num(left)}</b>, deadline }} />
 */
export function Tx({ k, vars }: { k: string; vars?: Record<string, React.ReactNode> }) {
  // Only the plain string/number vars can decide a plural; a React node cannot
  // be a count. Passing them through lets <Tx> pick the same singular form t()
  // would (see PLURAL_ONE_SUFFIX in translate.ts).
  const counts: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(vars || {})) {
    if (typeof value === "string" || typeof value === "number") counts[name] = value;
  }
  const template = templateIn(getLocale(), k, counts);
  const parts = splitTemplate(template);
  return (
    <>
      {parts.map((part, i) => {
        if (!part.name) return <React.Fragment key={i}>{part.text}</React.Fragment>;
        const value = vars?.[part.name];
        // An unfilled placeholder stays visible as itself rather than vanishing:
        // a missing variable is a bug, and a silently shortened sentence hides it.
        return <React.Fragment key={i}>{value === undefined ? part.text : value}</React.Fragment>;
      })}
    </>
  );
}
