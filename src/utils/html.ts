export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Limit visible text without leaving open HTML tags or splitting entities. */
export function truncateHtml(value: string, maxLength = 4096): string {
  const tokens = value.match(/<[^>]*>|&(?:#\d+|#x[\da-f]+|\w+);|[^<&]+|[<&]/gi) ?? [];
  const stack: string[] = [];
  const parts: string[] = [];
  const suffix = "\n\n[truncated]";
  let length = 0;
  const visibleLength = (token: string) => token.startsWith("<") && token.endsWith(">") ? 0 : token.startsWith("&") && token.endsWith(";") ? 1 : token.length;
  if (tokens.reduce((total, token) => total + visibleLength(token), 0) <= maxLength) return value;
  for (const token of tokens) {
    const tag = token.match(/^<\/?([\w-]+)(?:\s[^>]*)?>$/);
    if (tag) {
      if (token.startsWith("</")) stack.pop();
      else if (!token.endsWith("/>")) stack.push(tag[1]);
      parts.push(token);
      continue;
    }
    const remaining = Math.max(0, maxLength - suffix.length - length);
    const size = visibleLength(token);
    if (size > remaining) {
      if (!token.startsWith("&")) parts.push(Array.from(token.slice(0, remaining)).filter((character) => !/[\uD800-\uDBFF]$/.test(character)).join(""));
      break;
    }
    parts.push(token);
    length += size;
  }
  return parts.join("") + stack.reverse().map((tag) => `</${tag}>`).join("") + suffix;
}
