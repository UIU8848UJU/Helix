export function shellQuote(value: string): string {
  if (value.includes("\0")) throw new Error("NUL bytes are not allowed");
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
