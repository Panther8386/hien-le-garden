import { describe, it, expect } from 'vitest';
import { corsHeaders, handleCorsPreflight } from '../lib/cors.js';

describe('corsHeaders', () => {
  it('allows an origin on the allowlist', () => {
    const request = new Request('https://x', { headers: { Origin: 'https://hienlegarden.vn' } });
    const headers = corsHeaders(request);
    expect(headers['Access-Control-Allow-Origin']).toBe('https://hienlegarden.vn');
  });

  it('returns no CORS headers for an origin not on the allowlist', () => {
    const request = new Request('https://x', { headers: { Origin: 'https://evil.example' } });
    const headers = corsHeaders(request);
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });

  it('returns no CORS headers when there is no Origin header (same-origin request)', () => {
    const request = new Request('https://x');
    const headers = corsHeaders(request);
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
  });
});

describe('handleCorsPreflight', () => {
  it('responds 204 with the matched origin echoed back', async () => {
    const request = new Request('https://x', { headers: { Origin: 'http://localhost:4180' } });
    const response = handleCorsPreflight(request);
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:4180');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
  });
});
