import { describe, it, expect } from 'vitest';
import { generatePromoCode, addMonthsClamped, computeExpiry } from '../lib/promoCode.js';

describe('generatePromoCode', () => {
  it('matches the HLG-XXXXXX format with unambiguous characters', () => {
    const code = generatePromoCode();
    expect(code).toMatch(/^HLG-[A-HJ-NP-Z2-9]{6}$/);
  });

  it('produces different codes on repeated calls', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generatePromoCode()));
    expect(codes.size).toBe(50);
  });
});

describe('addMonthsClamped', () => {
  it('adds months within the same day-of-month when possible', () => {
    const result = addMonthsClamped(new Date('2026-01-15T00:00:00Z'), 6);
    expect(result.toISOString().slice(0, 10)).toBe('2026-07-15');
  });

  it('clamps to the last day of the target month on overflow', () => {
    // Aug 31 + 6 months = Feb, which has 28 days in 2027 (not a leap year)
    const result = addMonthsClamped(new Date('2026-08-31T00:00:00Z'), 6);
    expect(result.toISOString().slice(0, 10)).toBe('2027-02-28');
  });
});

describe('computeExpiry', () => {
  it('is exactly addMonthsClamped(submittedAt, 6)', () => {
    const submitted = new Date('2026-03-10T09:00:00Z');
    expect(computeExpiry(submitted).toISOString()).toBe(addMonthsClamped(submitted, 6).toISOString());
  });
});
