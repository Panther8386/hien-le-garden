
// Excludes 0/O and 1/I to avoid reception misreading codes read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generatePromoCode() {
  let code = '';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const byte of bytes) {
    code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  }
  return `HLG-${code}`;
}

export function addMonthsClamped(date, months) {
  const result = new Date(date.getTime());
  const targetMonth = result.getUTCMonth() + months;
  const originalDay = result.getUTCDate();

  result.setUTCDate(1); // avoid month-rollover surprises while shifting the month
  result.setUTCMonth(targetMonth);

  const lastDayOfTargetMonth = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)
  ).getUTCDate();

  result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));
  return result;
}

export function computeExpiry(submittedAt) {
  return addMonthsClamped(submittedAt, 6);
}
