// Allows the v4 marketing site to embed a survey form that calls this API
// cross-origin (crm.hienlegarden.vn is a separate Cloudflare Pages project).
const ALLOWED_ORIGINS = [
  'https://hienlegarden.vn',
  'https://www.hienlegarden.vn',
  'http://localhost:4180', // local v4 preview
  'http://localhost:4173', // local v3 preview (Playwright project)
  'http://localhost:4174', // local v4 preview (Playwright project)
];

export function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export function handleCorsPreflight(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
