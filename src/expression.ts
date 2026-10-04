/**
 * Tiny arithmetic evaluator for the coordinate fields, so an anchor can be nudged by typing
 * `1.5+0.25` instead of doing the arithmetic by hand.
 *
 * Deliberately hand-rolled instead of `eval` / `new Function`: the grammar below is the entire
 * accepted language, so an identifier, a stray character or an unbalanced paren simply fails to
 * parse and the caller reverts the field — which is exactly what a typo should do, and is the same
 * outcome the plain `Number()` parse used to give.
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := ('+' | '-') factor | primary
 *   primary := number | '(' expr ')'
 *
 * Returns null for anything that isn't a complete, finite expression.
 */
export function evaluateExpression(input: string): number | null {
  // Comma as decimal separator. This grammar has no argument lists, so every comma is a decimal
  // point — unlike the old single `replace(",", ".")`, which only converted the first one.
  const text = input.replace(/,/g, ".");
  let at = 0;

  const skipSpace = () => { while (at < text.length && /\s/.test(text[at]!)) at += 1; };
  const peek = () => { skipSpace(); return at < text.length ? text[at]! : ""; };
  const eat = (char: string) => { if (peek() !== char) return false; at += 1; return true; };

  const parsePrimary = (): number | null => {
    if (eat("(")) {
      const inner = parseExpr();
      if (inner === null || !eat(")")) return null;
      return inner;
    }
    skipSpace();
    const start = at;
    while (at < text.length && /[0-9.]/.test(text[at]!)) at += 1;
    if (at > start && (text[at] === "e" || text[at] === "E")) {
      // Only consume the exponent if it is well formed — otherwise `1e` would swallow the `e` and
      // then report a confusing failure further along instead of here.
      const mark = at;
      at += 1;
      if (text[at] === "+" || text[at] === "-") at += 1;
      if (at < text.length && /[0-9]/.test(text[at]!)) { while (at < text.length && /[0-9]/.test(text[at]!)) at += 1; }
      else at = mark;
    }
    if (at === start) return null;
    const value = Number(text.slice(start, at));
    return Number.isFinite(value) ? value : null;
  };

  const parseFactor = (): number | null => {
    if (eat("+")) return parseFactor();
    if (eat("-")) { const operand = parseFactor(); return operand === null ? null : -operand; }
    return parsePrimary();
  };

  const parseTerm = (): number | null => {
    let left = parseFactor();
    if (left === null) return null;
    for (;;) {
      const op = peek();
      if (op !== "*" && op !== "/") return left;
      at += 1;
      const right = parseFactor();
      if (right === null) return null;
      left = op === "*" ? left * right : left / right;
    }
  };

  const parseExpr = (): number | null => {
    let left = parseTerm();
    if (left === null) return null;
    for (;;) {
      const op = peek();
      if (op !== "+" && op !== "-") return left;
      at += 1;
      const right = parseTerm();
      if (right === null) return null;
      left = op === "+" ? left + right : left - right;
    }
  };

  const result = parseExpr();
  skipSpace();
  // Trailing junk (`1.5 foo`, `1.5)`) means the text was never an expression — reject the whole
  // thing rather than silently keeping the prefix that happened to parse.
  if (result === null || at !== text.length) return null;
  return Number.isFinite(result) ? result : null;
}

/**
 * Evaluates what the user typed into a numeric field.
 *
 * Nothing is implicit: the field is evaluated exactly as written. The field already contains its
 * current value and there is no select-on-focus, so the natural gesture — click at the end, type
 * `+0.25` — needs no special handling. A bare operator (`*2`, `/2`) is *not* treated as relative to
 * the current value; it simply fails to parse and the caller reverts the field.
 */
export function evaluateFieldInput(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  return evaluateExpression(trimmed);
}
