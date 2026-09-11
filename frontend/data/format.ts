/** Decimal-string rounding keeps DECIMAL128 and INT64 out of Number conversions. */
export function formatNumeric(text: string, decimals: number | null): string {
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 20) { return text; }
  const match = /^(-?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) { return text; }
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const shift = Number(exponent) - fraction.length + decimals;
  if (Math.abs(shift) > 10000) { return text; }
  let value = BigInt(whole + fraction);
  if (shift >= 0) { value *= 10n ** BigInt(shift); }
  else { const divisor = 10n ** BigInt(-shift); value = (value + divisor / 2n) / divisor; }
  const digits = value.toString().padStart(decimals + 1, '0');
  return (value ? sign : '') + (decimals ? `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}` : digits);
}

export function numericType(type: string): boolean { return /^(FLOAT|DOUBLE|DECIMAL\d*|float\d*|decimal)$/i.test(type); }

export function formatCell(text: string, type: string, decimals: number | null): string {
  if (decimals === null || !numericType(type.replace(/\[\]$/, ''))) { return text; }
  if (text.startsWith('[') && text.endsWith(']')) {
    return text.replace(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi, value => formatNumeric(value, decimals));
  }
  return formatNumeric(text, decimals);
}
