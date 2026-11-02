export function pasteInput(text: string, bracketed: boolean): string {
  const normalized = text.replace(/\r?\n/g, "\r");
  return bracketed ? `\x1b[200~${normalized}\x1b[201~` : normalized;
}

export function controlInput(text: string): string | undefined {
  if (text.length !== 1) return;
  const char = text.toUpperCase().charCodeAt(0);
  if (char >= 64 && char <= 95) return String.fromCharCode(char - 64);
  if (text === " ") return "\x00";
  if (text === "?") return "\x7f";
}
