# Điều chỉnh Menu quán Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bổ sung nhóm (subgroup), đơn vị (unit), cờ "Cần đặt trước" cho `dine_in_menu_items`, và cho phép admin sắp xếp thứ tự món trong nhóm lẫn thứ tự giữa các nhóm — khớp với thực đơn thật của quán.

**Architecture:** Migration additive (3 cột mới). Tái dùng cột `display_order` sẵn có làm khoá sắp xếp liên tục xuyên suốt từng `category` — món cùng `subgroup` luôn nằm thành khối liền kề. Vì vậy mọi thao tác tạo món mới hoặc đổi `subgroup` của món phải đánh số lại `display_order` để giữ đúng tính liên tục này — dùng chung 1 hàm thuần (`lib/dineInMenuOrdering.js`) cho cả tạo mới lẫn sửa, tránh trùng lặp logic phức tạp.

**Tech Stack:** Cloudflare Pages Functions + D1 (SQLite), vanilla JS admin frontend (không build step), Playwright cho e2e.

**Spec:** docs/superpowers/specs/2026-09-04-dine-in-menu-rework-design.md

## Global Constraints

- Không đổi `category` ('mon_an'/'do_uong') hay tính bất biến của nó sau khi tạo.
- `subgroup`/`unit` dùng chung cho cả 2 loại; `requires_preorder` chỉ áp dụng cho `mon_an` — nếu body gửi `requiresPreorder=true` cho món `do_uong` thì bỏ qua, luôn lưu `0`.
- Không xoá cứng món — vẫn theo `is_active`.
- **Bất biến bắt buộc**: món cùng `(category, subgroup)` luôn là 1 khối `display_order` liên tục. Mọi thao tác tạo món mới hoặc đổi `subgroup` PHẢI đánh số lại toàn bộ `display_order` trong `category` đó để giữ đúng bất biến này — dùng `lib/dineInMenuOrdering.js#computeInsertionOrder`.
- Roles: `POST`/`PATCH`/2 endpoint sắp xếp mới đều chỉ `admin` (giữ nguyên quy ước hiện có của `/api/dine-in-menu`). `GET` giữ nguyên `reception, manager, admin, observer`.
- Không dùng `window.confirm()` ở bất kỳ đâu (quy ước codebase).
- Migration này lấy số **0022** (migration 0022 chưa từng tồn tại thật — chỉ được dự trù trên giấy trong plan Giờ Xanh Hiền Lê, chưa triển khai). Task cuối của plan này phải đổi số migration của plan Giờ Xanh từ 0022 sang **0023** để tránh trùng.

---

### Task 1: Migration — 3 cột mới

**Files:**
- Create: `v4/migrations/0022_dine_in_menu_items_grouping.sql`
- Test: `v4/test/migrations.test.js` (thêm `describe('migration 0022', ...)` vào cuối file)

**Interfaces:**
- Produces: `dine_in_menu_items.subgroup` (TEXT, nullable), `.unit` (TEXT, nullable), `.requires_preorder` (INTEGER NOT NULL DEFAULT 0). Mọi task sau dùng đúng tên cột này.

- [ ] **Step 1: Viết migration**

Tạo `v4/migrations/0022_dine_in_menu_items_grouping.sql`:

```sql
-- v4/migrations/0022_dine_in_menu_items_grouping.sql

ALTER TABLE dine_in_menu_items ADD COLUMN subgroup TEXT;
ALTER TABLE dine_in_menu_items ADD COLUMN unit TEXT;
ALTER TABLE dine_in_menu_items ADD COLUMN requires_preorder INTEGER NOT NULL DEFAULT 0;
```

- [ ] **Step 2: Viết test**

Thêm vào cuối `v4/test/migrations.test.js`:

```js
describe('migration 0022', () => {
  it('adds subgroup, unit, and requires_preorder, defaulting correctly', async () => {
    const result = await env.DB.prepare(
      `INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at) VALUES ('Test Item', 'mon_an', 50000, 0, 1, 'system', '2026-09-04T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT subgroup, unit, requires_preorder FROM dine_in_menu_items WHERE id = ?`).bind(result.meta.last_row_id).first();
    expect(row).toEqual({ subgroup: null, unit: null, requires_preorder: 0 });
  });

  it('accepts values for all three new columns', async () => {
    const result = await env.DB.prepare(
      `INSERT INTO dine_in_menu_items (name, category, price, subgroup, unit, requires_preorder, display_order, is_active, updated_by, updated_at) VALUES ('Gà nướng', 'mon_an', 368000, 'Món gà', 'con', 1, 0, 1, 'system', '2026-09-04T00:00:00Z')`
    ).run();
    const row = await env.DB.prepare(`SELECT subgroup, unit, requires_preorder FROM dine_in_menu_items WHERE id = ?`).bind(result.meta.last_row_id).first();
    expect(row).toEqual({ subgroup: 'Món gà', unit: 'con', requires_preorder: 1 });
  });
});
```

- [ ] **Step 3: Chạy test**

Run: `cd v4 && npx vitest run test/migrations.test.js`
Expected: PASS (toàn bộ file, bao gồm các describe cũ).

- [ ] **Step 4: Commit**

```bash
cd v4
git add migrations/0022_dine_in_menu_items_grouping.sql test/migrations.test.js
git commit -m "feat: add subgroup/unit/requires_preorder columns to dine_in_menu_items

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Hàm thuần dùng chung cho đánh số lại thứ tự khi chèn/đổi nhóm

**Files:**
- Create: `v4/lib/dineInMenuOrdering.js`
- Test: `v4/test/dineInMenuOrdering.test.js` (mới)

**Interfaces:**
- Produces: `computeInsertionOrder(existingItems, targetSubgroup)` — hàm thuần, không phụ thuộc DB. `existingItems`: mảng `{ id, subgroup }` đã sắp theo `display_order` tăng dần (KHÔNG bao gồm món đang chèn/di chuyển). `targetSubgroup`: chuỗi hoặc `null`/`''` (coi như cùng 1 nhóm "chưa phân loại"). Trả về mảng các `id` theo thứ tự MỚI, với đúng 1 phần tử `null` đánh dấu vị trí của món đang chèn/di chuyển — món này luôn được đặt ở CUỐI khối khớp `targetSubgroup` nếu khối đó đã tồn tại, hoặc thành khối mới ở CUỐI danh sách nếu chưa có nhóm nào khớp. Task 3 dùng hàm này trong cả `POST` (chèn món mới) lẫn `PATCH` (khi đổi `subgroup`).

- [ ] **Step 1: Viết test trước**

Tạo `v4/test/dineInMenuOrdering.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { computeInsertionOrder } from '../lib/dineInMenuOrdering.js';

describe('computeInsertionOrder', () => {
  it('places the new item alone when the list is empty', () => {
    expect(computeInsertionOrder([], 'Hải sản')).toEqual([null]);
  });

  it('appends a new block at the end when the subgroup does not exist yet', () => {
    const existing = [
      { id: 1, subgroup: 'Hải sản' },
      { id: 2, subgroup: 'Hải sản' },
      { id: 3, subgroup: 'Món gà' },
    ];
    expect(computeInsertionOrder(existing, 'Lẩu')).toEqual([1, 2, 3, null]);
  });

  it('inserts at the end of an existing matching block, preserving other blocks order', () => {
    const existing = [
      { id: 1, subgroup: 'Hải sản' },
      { id: 2, subgroup: 'Hải sản' },
      { id: 3, subgroup: 'Món gà' },
    ];
    expect(computeInsertionOrder(existing, 'Hải sản')).toEqual([1, 2, null, 3]);
  });

  it('groups items with no subgroup (null) as their own block', () => {
    const existing = [
      { id: 1, subgroup: null },
      { id: 2, subgroup: 'Hải sản' },
    ];
    expect(computeInsertionOrder(existing, null)).toEqual([1, null, 2]);
  });

  it('treats an empty-string target subgroup the same as null', () => {
    const existing = [{ id: 1, subgroup: null }];
    expect(computeInsertionOrder(existing, '')).toEqual([1, null]);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận lỗi**

Run: `cd v4 && npx vitest run test/dineInMenuOrdering.test.js`
Expected: FAIL — `lib/dineInMenuOrdering.js` chưa tồn tại.

- [ ] **Step 3: Viết implementation**

Tạo `v4/lib/dineInMenuOrdering.js`:

```js
// v4/lib/dineInMenuOrdering.js
//
// Món cùng (category, subgroup) luôn phải là 1 khối display_order liên tục -- đây là bất biến
// bắt buộc để việc gộp nhóm hiển thị (client) và di chuyển cả nhóm (move-group endpoint) hoạt
// động đúng. Hàm này tính thứ tự MỚI (chỉ gồm id các món hiện có + 1 vị trí `null` đánh dấu món
// đang chèn/di chuyển) sao cho món đó luôn nằm cuối khối nhóm đích, giữ nguyên thứ tự nội bộ mọi
// khối khác.
export function computeInsertionOrder(existingItems, targetSubgroup) {
  const blocks = [];
  existingItems.forEach((it) => {
    const key = it.subgroup || null;
    const last = blocks[blocks.length - 1];
    if (last && last.key === key) {
      last.ids.push(it.id);
    } else {
      blocks.push({ key, ids: [it.id] });
    }
  });

  const normalizedTarget = targetSubgroup || null;
  const matchingBlockIndex = blocks.findIndex((b) => b.key === normalizedTarget);

  const orderedIds = [];
  if (matchingBlockIndex === -1) {
    blocks.forEach((b) => b.ids.forEach((id) => orderedIds.push(id)));
    orderedIds.push(null);
  } else {
    blocks.forEach((b, idx) => {
      b.ids.forEach((id) => orderedIds.push(id));
      if (idx === matchingBlockIndex) orderedIds.push(null);
    });
  }
  return orderedIds;
}
```

- [ ] **Step 4: Chạy test để xác nhận pass**

Run: `cd v4 && npx vitest run test/dineInMenuOrdering.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
cd v4
git add lib/dineInMenuOrdering.js test/dineInMenuOrdering.test.js
git commit -m "feat: add computeInsertionOrder helper for dine-in menu subgroup ordering

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Mở rộng GET/POST/PATCH `/api/dine-in-menu` (subgroup, unit, requiresPreorder)

**Files:**
- Modify: `v4/functions/api/dine-in-menu/index.js`
- Modify: `v4/functions/api/dine-in-menu/[id].js`
- Test: `v4/test/dineInMenu.test.js` (sửa 1 test hiện có + thêm test mới)

**Interfaces:**
- Consumes: `computeInsertionOrder` (Task 2).
- Produces: `GET /api/dine-in-menu` → mỗi món thêm `subgroup`, `unit`, `requiresPreorder`. `POST`/`PATCH` nhận thêm các field này trong body. Task 4/5/6/7 dùng đúng field name này.

- [ ] **Step 1: Sửa `coerceRow` và câu SELECT trong `index.js`**

Trong `v4/functions/api/dine-in-menu/index.js`, thay toàn bộ hàm `coerceRow`:

```js
function coerceRow(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    price: r.price,
    subgroup: r.subgroup,
    unit: r.unit,
    requiresPreorder: !!r.requires_preorder,
    displayOrder: r.display_order,
    isActive: !!r.is_active,
    updatedBy: r.updated_by,
    updatedAt: r.updated_at,
  };
}
```

- [ ] **Step 2: Viết lại `onRequestPost` trong `index.js` (chèn món mới đánh số lại đúng vị trí khối nhóm)**

Trong `v4/functions/api/dine-in-menu/index.js`, thêm import ở đầu file (ngay dưới `import { requireAuth }`):

```js
import { computeInsertionOrder } from '../../../lib/dineInMenuOrdering.js';
```

Thay toàn bộ hàm `onRequestPost`:

```js
export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { name, category, price, subgroup, unit, requiresPreorder } = body || {};

  if (typeof name !== 'string' || name.trim() === '') return jsonError('Tên món không được để trống', 400);
  if (name.trim().length > 200) return jsonError('Tên món quá dài', 400);
  if (!VALID_CATEGORIES.includes(category)) return jsonError('Loại món không hợp lệ', 400);
  if (!Number.isInteger(price) || price <= 0) return jsonError('Giá phải là số nguyên lớn hơn 0', 400);
  if (subgroup !== undefined && subgroup !== null && (typeof subgroup !== 'string' || subgroup.length > 100)) return jsonError('Nhóm không hợp lệ', 400);
  if (unit !== undefined && unit !== null && (typeof unit !== 'string' || unit.length > 100)) return jsonError('Đơn vị không hợp lệ', 400);

  const trimmedName = name.trim();
  const trimmedSubgroup = subgroup ? String(subgroup).trim() || null : null;
  const trimmedUnit = unit ? String(unit).trim() || null : null;
  const resolvedPreorder = category === 'mon_an' && requiresPreorder === true;
  const now = new Date().toISOString();

  const { results: existing } = await env.DB.prepare(
    `SELECT id, subgroup FROM dine_in_menu_items WHERE category = ? ORDER BY display_order`
  ).bind(category).all();

  const insert = await env.DB.prepare(
    `INSERT INTO dine_in_menu_items (name, category, price, subgroup, unit, requires_preorder, display_order, is_active, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`
  ).bind(trimmedName, category, price, trimmedSubgroup, trimmedUnit, resolvedPreorder ? 1 : 0, auth.username, now).run();
  const newId = insert.meta.last_row_id;

  const orderedIds = computeInsertionOrder(existing, trimmedSubgroup);
  const renumberStatements = orderedIds.map((id, index) =>
    env.DB.prepare(`UPDATE dine_in_menu_items SET display_order = ? WHERE id = ?`).bind(index, id === null ? newId : id)
  );
  await env.DB.batch(renumberStatements);

  await env.DB.prepare(
    `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
     VALUES ('dine_in_menu_item_create', 'dine_in_menu_item', ?, ?, NULL, ?, ?, ?)`
  ).bind(newId, trimmedName, `${trimmedName} — ${price.toLocaleString('vi-VN')}đ`, auth.username, now).run();

  const finalDisplayOrder = orderedIds.findIndex((id) => id === null);
  return new Response(
    JSON.stringify({ id: newId, name: trimmedName, category, price, subgroup: trimmedSubgroup, unit: trimmedUnit, requiresPreorder: resolvedPreorder, displayOrder: finalDisplayOrder, isActive: true }),
    { status: 201, headers: { 'Content-Type': 'application/json' } }
  );
}
```

- [ ] **Step 3: Viết lại `onRequestPatch` trong `[id].js` (đổi `subgroup` đánh số lại đúng vị trí khối nhóm)**

Thay toàn bộ nội dung `v4/functions/api/dine-in-menu/[id].js`:

```js
import { requireAuth } from '../../../lib/requireAuth.js';
import { computeInsertionOrder } from '../../../lib/dineInMenuOrdering.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const existing = await env.DB.prepare(`SELECT * FROM dine_in_menu_items WHERE id = ?`).bind(params.id).first();
  if (!existing) return jsonError('Không tìm thấy món', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const safeBody = body || {};
  const name = safeBody.name !== undefined ? safeBody.name : existing.name;
  const price = safeBody.price !== undefined ? safeBody.price : existing.price;
  const isActive = safeBody.isActive !== undefined ? safeBody.isActive : !!existing.is_active;
  const unit = safeBody.unit !== undefined ? safeBody.unit : existing.unit;
  const requiresPreorder = safeBody.requiresPreorder !== undefined ? safeBody.requiresPreorder : !!existing.requires_preorder;
  // `category` is intentionally never read from the request body -- immutable after creation.

  if (typeof name !== 'string' || name.trim() === '') return jsonError('Tên món không được để trống', 400);
  if (name.trim().length > 200) return jsonError('Tên món quá dài', 400);
  if (!Number.isInteger(price) || price <= 0) return jsonError('Giá phải là số nguyên lớn hơn 0', 400);
  if (unit !== undefined && unit !== null && (typeof unit !== 'string' || unit.length > 100)) return jsonError('Đơn vị không hợp lệ', 400);
  if (safeBody.subgroup !== undefined && safeBody.subgroup !== null && (typeof safeBody.subgroup !== 'string' || safeBody.subgroup.length > 100)) return jsonError('Nhóm không hợp lệ', 400);

  const trimmedName = name.trim();
  const trimmedUnit = unit ? String(unit).trim() || null : null;
  const resolvedPreorder = existing.category === 'mon_an' && requiresPreorder === true;
  const now = new Date().toISOString();

  const subgroupChanging = safeBody.subgroup !== undefined && (safeBody.subgroup || null) !== (existing.subgroup || null);
  const trimmedSubgroup = subgroupChanging ? (safeBody.subgroup ? String(safeBody.subgroup).trim() || null : null) : existing.subgroup;

  const statements = [
    env.DB.prepare(`UPDATE dine_in_menu_items SET name = ?, price = ?, is_active = ?, subgroup = ?, unit = ?, requires_preorder = ?, updated_by = ?, updated_at = ? WHERE id = ?`)
      .bind(trimmedName, price, isActive ? 1 : 0, trimmedSubgroup, trimmedUnit, resolvedPreorder ? 1 : 0, auth.username, now, params.id),
    env.DB.prepare(
      `INSERT INTO audit_log (action_type, entity_type, entity_id, entity_label, old_value, new_value, actor, created_at)
       VALUES ('dine_in_menu_item_update', 'dine_in_menu_item', ?, ?, ?, ?, ?, ?)`
    ).bind(
      params.id,
      trimmedName,
      `${existing.name} — ${existing.price.toLocaleString('vi-VN')}đ (${existing.is_active ? 'active' : 'inactive'})`,
      `${trimmedName} — ${price.toLocaleString('vi-VN')}đ (${isActive ? 'active' : 'inactive'})`,
      auth.username,
      now
    ),
  ];

  if (subgroupChanging) {
    const { results: siblingsExcludingSelf } = await env.DB.prepare(
      `SELECT id, subgroup FROM dine_in_menu_items WHERE category = ? AND id != ? ORDER BY display_order`
    ).bind(existing.category, params.id).all();
    const orderedIds = computeInsertionOrder(siblingsExcludingSelf, trimmedSubgroup);
    orderedIds.forEach((id, index) => {
      statements.push(
        env.DB.prepare(`UPDATE dine_in_menu_items SET display_order = ? WHERE id = ?`).bind(index, id === null ? params.id : id)
      );
    });
  }

  await env.DB.batch(statements);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 4: Sửa test đã có bị vỡ do thêm field mới**

Trong `v4/test/dineInMenu.test.js`, test `'returns created items including inactive ones'` (trong `describe('GET /api/dine-in-menu', ...)`) đang `toEqual` khớp tuyệt đối toàn bộ object trả về — thêm field mới sẽ làm test này FAIL nếu không cập nhật. Thay toàn bộ test đó:

```js
  it('returns created items including inactive ones', async () => {
    await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at) VALUES ('Cà phê đen', 'do_uong', 25000, 1, 0, 'system', '2026-09-04T00:00:00Z')`).run();
    const response = await listMenu({ request: authedRequest('https://x/api/dine-in-menu', adminToken, 'GET'), env });
    const body = await response.json();
    expect(body).toEqual([
      { id: expect.any(Number), name: 'Cà phê đen', category: 'do_uong', price: 25000, subgroup: null, unit: null, requiresPreorder: false, displayOrder: 1, isActive: false, updatedBy: 'system', updatedAt: '2026-09-04T00:00:00Z' },
    ]);
  });
```

- [ ] **Step 5: Thêm test mới cho POST/PATCH**

Thêm vào cuối `describe('POST /api/dine-in-menu', ...)` trong `v4/test/dineInMenu.test.js` (ngay trước dấu `});` đóng describe):

```js

  it('accepts subgroup/unit/requiresPreorder for mon_an, appending at the end of a new subgroup block', async () => {
    const response = await createMenuItem({ request: authedRequest('https://x/api/dine-in-menu', adminToken, 'POST', { name: 'Gà nướng', category: 'mon_an', price: 368000, subgroup: 'Món gà', unit: 'con', requiresPreorder: true }), env });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({ subgroup: 'Món gà', unit: 'con', requiresPreorder: true });

    const row = await env.DB.prepare(`SELECT subgroup, unit, requires_preorder FROM dine_in_menu_items WHERE id = ?`).bind(body.id).first();
    expect(row).toEqual({ subgroup: 'Món gà', unit: 'con', requires_preorder: 1 });
  });

  it('ignores requiresPreorder for do_uong, always storing 0', async () => {
    const response = await createMenuItem({ request: authedRequest('https://x/api/dine-in-menu', adminToken, 'POST', { name: 'Cà phê sữa', category: 'do_uong', price: 25000, requiresPreorder: true }), env });
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.requiresPreorder).toBe(false);
    const row = await env.DB.prepare(`SELECT requires_preorder FROM dine_in_menu_items WHERE id = ?`).bind(body.id).first();
    expect(row.requires_preorder).toBe(0);
  });

  it('inserts a second item into the same subgroup block, keeping it contiguous and after the first', async () => {
    const first = await createMenuItem({ request: authedRequest('https://x/api/dine-in-menu', adminToken, 'POST', { name: 'Gỏi hải sản', category: 'mon_an', price: 179000, subgroup: 'Hải sản' }), env });
    const firstBody = await first.json();
    const secondResponse = await createMenuItem({ request: authedRequest('https://x/api/dine-in-menu', adminToken, 'POST', { name: 'Tôm sốt', category: 'mon_an', price: 275000, subgroup: 'Hải sản' }), env });
    const secondBody = await secondResponse.json();

    const firstRow = await env.DB.prepare(`SELECT display_order FROM dine_in_menu_items WHERE id = ?`).bind(firstBody.id).first();
    const secondRow = await env.DB.prepare(`SELECT display_order FROM dine_in_menu_items WHERE id = ?`).bind(secondBody.id).first();
    expect(secondRow.display_order).toBe(firstRow.display_order + 1);
  });
```

Thêm vào cuối `describe('PATCH /api/dine-in-menu/:id', ...)` trong `v4/test/dineInMenu.test.js` (ngay trước dấu `});` đóng describe):

```js

  it('accepts subgroup/unit/requiresPreorder updates', async () => {
    const created = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, display_order, is_active, updated_by, updated_at) VALUES ('Cá tầm nướng', 'mon_an', 210000, 5, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    const response = await patchMenuItem({ request: authedRequest(`https://x/api/dine-in-menu/${created.meta.last_row_id}`, adminToken, 'PATCH', { subgroup: 'Món gà', unit: 'phần', requiresPreorder: true }), env, params: { id: String(created.meta.last_row_id) } });
    expect(response.status).toBe(200);
    const row = await env.DB.prepare(`SELECT subgroup, unit, requires_preorder FROM dine_in_menu_items WHERE id = ?`).bind(created.meta.last_row_id).first();
    expect(row).toEqual({ subgroup: 'Món gà', unit: 'phần', requires_preorder: 1 });
  });

  it('moving an item to a different subgroup keeps display_order contiguous within the new group', async () => {
    const a = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Món gà 1', 'mon_an', 100000, 'Món gà', 0, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    const b = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Hải sản 1', 'mon_an', 100000, 'Hải sản', 1, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    const c = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Hải sản 2', 'mon_an', 100000, 'Hải sản', 2, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();

    const response = await patchMenuItem({ request: authedRequest(`https://x/api/dine-in-menu/${a.meta.last_row_id}`, adminToken, 'PATCH', { subgroup: 'Hải sản' }), env, params: { id: String(a.meta.last_row_id) } });
    expect(response.status).toBe(200);

    const { results } = await env.DB.prepare(`SELECT id, subgroup FROM dine_in_menu_items WHERE category = 'mon_an' ORDER BY display_order`).all();
    expect(results).toEqual([
      { id: b.meta.last_row_id, subgroup: 'Hải sản' },
      { id: c.meta.last_row_id, subgroup: 'Hải sản' },
      { id: a.meta.last_row_id, subgroup: 'Hải sản' },
    ]);
  });
```

- [ ] **Step 6: Chạy test**

Run: `cd v4 && npx vitest run test/dineInMenu.test.js`
Expected: PASS (16 tests: 11 gốc còn lại sau khi sửa 1 + 5 mới).

- [ ] **Step 7: Commit**

```bash
cd v4
git add functions/api/dine-in-menu test/dineInMenu.test.js
git commit -m "feat: add subgroup/unit/requiresPreorder to dine-in-menu API, keep display_order contiguous per subgroup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Endpoint sắp xếp — di chuyển món trong nhóm, di chuyển cả nhóm

**Files:**
- Create: `v4/functions/api/dine-in-menu/[id]/move.js`
- Create: `v4/functions/api/dine-in-menu/move-group.js`
- Test: `v4/test/dineInMenu.test.js` (thêm 2 describe block mới vào cuối file)

**Interfaces:**
- Consumes: `dine_in_menu_items` với bất biến "cùng subgroup = khối liên tục" (Task 3 đảm bảo).
- Produces: `PATCH /api/dine-in-menu/:id/move` → `200 { ok: true }`. `POST /api/dine-in-menu/move-group` → `200 { ok: true }`.

- [ ] **Step 1: Viết endpoint di chuyển 1 món trong nhóm**

Tạo `v4/functions/api/dine-in-menu/[id]/move.js`:

```js
import { requireAuth } from '../../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPatch({ request, env, params }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  const item = await env.DB.prepare(`SELECT id, category, subgroup, display_order FROM dine_in_menu_items WHERE id = ?`).bind(params.id).first();
  if (!item) return jsonError('Không tìm thấy món', 404);

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { direction } = body || {};
  if (direction !== 'up' && direction !== 'down') return jsonError('Hướng di chuyển không hợp lệ', 400);

  const { results: siblings } = await env.DB.prepare(
    `SELECT id, display_order FROM dine_in_menu_items WHERE category = ? AND (subgroup = ? OR (subgroup IS NULL AND ? IS NULL)) ORDER BY display_order`
  ).bind(item.category, item.subgroup, item.subgroup).all();

  const index = siblings.findIndex((s) => s.id === item.id);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= siblings.length) {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const target = siblings[targetIndex];
  await env.DB.batch([
    env.DB.prepare(`UPDATE dine_in_menu_items SET display_order = ? WHERE id = ?`).bind(target.display_order, item.id),
    env.DB.prepare(`UPDATE dine_in_menu_items SET display_order = ? WHERE id = ?`).bind(item.display_order, target.id),
  ]);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 2: Viết endpoint di chuyển cả nhóm**

Tạo `v4/functions/api/dine-in-menu/move-group.js`:

```js
import { requireAuth } from '../../../lib/requireAuth.js';

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: { 'Content-Type': 'application/json' } });
}

const VALID_CATEGORIES = ['mon_an', 'do_uong'];

export async function onRequestPost({ request, env }) {
  const auth = await requireAuth(request, env, ['admin']);
  if (auth instanceof Response) return auth;

  let body;
  try {
    body = await request.json();
  } catch (err) {
    return jsonError('Dữ liệu không hợp lệ', 400);
  }
  const { category, subgroup, direction } = body || {};
  if (!VALID_CATEGORIES.includes(category)) return jsonError('Loại món không hợp lệ', 400);
  if (direction !== 'up' && direction !== 'down') return jsonError('Hướng di chuyển không hợp lệ', 400);

  const { results: allItems } = await env.DB.prepare(
    `SELECT id, subgroup, display_order FROM dine_in_menu_items WHERE category = ? ORDER BY display_order`
  ).bind(category).all();

  const blocks = [];
  allItems.forEach((it) => {
    const key = it.subgroup || null;
    const last = blocks[blocks.length - 1];
    if (last && last.key === key) {
      last.items.push(it);
    } else {
      blocks.push({ key, items: [it] });
    }
  });

  const normalizedSubgroup = subgroup || null;
  const blockIndex = blocks.findIndex((b) => b.key === normalizedSubgroup);
  if (blockIndex === -1) return jsonError('Không tìm thấy nhóm', 404);

  const targetIndex = direction === 'up' ? blockIndex - 1 : blockIndex + 1;
  if (targetIndex < 0 || targetIndex >= blocks.length) {
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  const blockA = blocks[blockIndex];
  const blockB = blocks[targetIndex];
  const [earlierBlock, laterBlock] = blockIndex < targetIndex ? [blockA, blockB] : [blockB, blockA];
  const combinedOrders = [...earlierBlock.items, ...laterBlock.items]
    .map((it) => it.display_order)
    .sort((a, b) => a - b);

  const statements = [];
  laterBlock.items.forEach((it, i) => {
    statements.push(env.DB.prepare(`UPDATE dine_in_menu_items SET display_order = ? WHERE id = ?`).bind(combinedOrders[i], it.id));
  });
  earlierBlock.items.forEach((it, i) => {
    statements.push(env.DB.prepare(`UPDATE dine_in_menu_items SET display_order = ? WHERE id = ?`).bind(combinedOrders[laterBlock.items.length + i], it.id));
  });
  await env.DB.batch(statements);

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

- [ ] **Step 3: Viết test**

Thêm import vào đầu `v4/test/dineInMenu.test.js`, cạnh các import đã có:

```js
import { onRequestPatch as moveItem } from '../functions/api/dine-in-menu/[id]/move.js';
import { onRequestPost as moveGroup } from '../functions/api/dine-in-menu/move-group.js';
```

Thêm vào cuối file, sau describe block `PATCH /api/dine-in-menu/:id`:

```js
describe('PATCH /api/dine-in-menu/:id/move', () => {
  let idA, idB, idC, idOther;
  beforeEach(async () => {
    const a = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Hải sản A', 'mon_an', 100000, 'Hải sản', 0, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    const b = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Hải sản B', 'mon_an', 100000, 'Hải sản', 1, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    const c = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Hải sản C', 'mon_an', 100000, 'Hải sản', 2, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    const other = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Món gà D', 'mon_an', 100000, 'Món gà', 3, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    idA = a.meta.last_row_id; idB = b.meta.last_row_id; idC = c.meta.last_row_id; idOther = other.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await moveItem({ request: new Request(`https://x/api/dine-in-menu/${idB}/move`, { method: 'PATCH' }), env, params: { id: String(idB) } });
    expect(response.status).toBe(401);
  });

  it('rejects non-admin roles (403)', async () => {
    const response = await moveItem({ request: authedRequest(`https://x/api/dine-in-menu/${idB}/move`, managerToken, 'PATCH', { direction: 'up' }), env, params: { id: String(idB) } });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent id', async () => {
    const response = await moveItem({ request: authedRequest('https://x/api/dine-in-menu/999999/move', adminToken, 'PATCH', { direction: 'up' }), env, params: { id: '999999' } });
    expect(response.status).toBe(404);
  });

  it('rejects an invalid direction (400)', async () => {
    const response = await moveItem({ request: authedRequest(`https://x/api/dine-in-menu/${idB}/move`, adminToken, 'PATCH', { direction: 'sideways' }), env, params: { id: String(idB) } });
    expect(response.status).toBe(400);
  });

  it('swaps display_order with the adjacent same-subgroup item when moving up', async () => {
    const response = await moveItem({ request: authedRequest(`https://x/api/dine-in-menu/${idB}/move`, adminToken, 'PATCH', { direction: 'up' }), env, params: { id: String(idB) } });
    expect(response.status).toBe(200);
    const { results } = await env.DB.prepare(`SELECT id, display_order FROM dine_in_menu_items WHERE subgroup = 'Hải sản' ORDER BY display_order`).all();
    expect(results.map((r) => r.id)).toEqual([idB, idA, idC]);
  });

  it('does nothing (200, no change) when already at the top of its group', async () => {
    const response = await moveItem({ request: authedRequest(`https://x/api/dine-in-menu/${idA}/move`, adminToken, 'PATCH', { direction: 'up' }), env, params: { id: String(idA) } });
    expect(response.status).toBe(200);
    const { results } = await env.DB.prepare(`SELECT id FROM dine_in_menu_items WHERE subgroup = 'Hải sản' ORDER BY display_order`).all();
    expect(results.map((r) => r.id)).toEqual([idA, idB, idC]);
  });

  it('does not cross into an item from a different subgroup even when it is the numerically-nearest neighbor', async () => {
    const response = await moveItem({ request: authedRequest(`https://x/api/dine-in-menu/${idC}/move`, adminToken, 'PATCH', { direction: 'down' }), env, params: { id: String(idC) } });
    expect(response.status).toBe(200);
    const otherRow = await env.DB.prepare(`SELECT display_order FROM dine_in_menu_items WHERE id = ?`).bind(idOther).first();
    expect(otherRow.display_order).toBe(3);
  });
});

describe('POST /api/dine-in-menu/move-group', () => {
  let idA1, idA2, idB1, idC1;
  beforeEach(async () => {
    const a1 = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Hải sản A', 'mon_an', 100000, 'Hải sản', 0, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    const a2 = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Hải sản B', 'mon_an', 100000, 'Hải sản', 1, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    const b1 = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Món gà A', 'mon_an', 100000, 'Món gà', 2, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    const c1 = await env.DB.prepare(`INSERT INTO dine_in_menu_items (name, category, price, subgroup, display_order, is_active, updated_by, updated_at) VALUES ('Lẩu A', 'mon_an', 100000, 'Lẩu', 3, 1, 'admin_menu', '2026-09-04T00:00:00Z')`).run();
    idA1 = a1.meta.last_row_id; idA2 = a2.meta.last_row_id; idB1 = b1.meta.last_row_id; idC1 = c1.meta.last_row_id;
  });

  it('rejects unauthenticated requests', async () => {
    const response = await moveGroup({ request: new Request('https://x/api/dine-in-menu/move-group', { method: 'POST' }), env });
    expect(response.status).toBe(401);
  });

  it('rejects non-admin roles (403)', async () => {
    const response = await moveGroup({ request: authedRequest('https://x/api/dine-in-menu/move-group', managerToken, 'POST', { category: 'mon_an', subgroup: 'Món gà', direction: 'up' }), env });
    expect(response.status).toBe(403);
  });

  it('404s for a non-existent subgroup', async () => {
    const response = await moveGroup({ request: authedRequest('https://x/api/dine-in-menu/move-group', adminToken, 'POST', { category: 'mon_an', subgroup: 'Không tồn tại', direction: 'up' }), env });
    expect(response.status).toBe(404);
  });

  it('moving "Món gà" up swaps its whole block with "Hải sản", preserving internal order of both', async () => {
    const response = await moveGroup({ request: authedRequest('https://x/api/dine-in-menu/move-group', adminToken, 'POST', { category: 'mon_an', subgroup: 'Món gà', direction: 'up' }), env });
    expect(response.status).toBe(200);
    const { results } = await env.DB.prepare(`SELECT id, subgroup FROM dine_in_menu_items WHERE category = 'mon_an' ORDER BY display_order`).all();
    expect(results.map((r) => r.id)).toEqual([idB1, idA1, idA2, idC1]);
  });

  it('does nothing (200, no change) when the first group tries to move up', async () => {
    const response = await moveGroup({ request: authedRequest('https://x/api/dine-in-menu/move-group', adminToken, 'POST', { category: 'mon_an', subgroup: 'Hải sản', direction: 'up' }), env });
    expect(response.status).toBe(200);
    const { results } = await env.DB.prepare(`SELECT id FROM dine_in_menu_items WHERE category = 'mon_an' ORDER BY display_order`).all();
    expect(results.map((r) => r.id)).toEqual([idA1, idA2, idB1, idC1]);
  });
});
```

- [ ] **Step 4: Chạy test**

Run: `cd v4 && npx vitest run test/dineInMenu.test.js`
Expected: PASS (28 tests: 16 từ Task 3 + 12 mới).

- [ ] **Step 5: Commit**

```bash
cd v4
git add functions/api/dine-in-menu test/dineInMenu.test.js
git commit -m "feat: add dine-in-menu item/group reorder endpoints (move, move-group)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Client — Menu quán (nhóm, đơn vị, đặt trước, sắp xếp ▲▼)

**Files:**
- Modify: `v4/admin/dine-in-menu.html`
- Modify: `v4/admin/dine-in-menu.js`

**Interfaces:**
- Consumes: `GET/POST /api/dine-in-menu`, `PATCH /api/dine-in-menu/:id`, `PATCH /api/dine-in-menu/:id/move`, `POST /api/dine-in-menu/move-group` (Task 3/4).
- Produces: không có interface nào task sau dùng lại (trang độc lập).

- [ ] **Step 1: Viết lại HTML**

Thay toàn bộ nội dung `v4/admin/dine-in-menu.html`:

```html
<!-- v4/admin/dine-in-menu.html -->
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Menu quán — Hiền Lê Garden CRM</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin/admin.css" />
</head>
<body>
  <div class="page page-wide">
    <h1>Menu quán</h1>
    <p id="pageError" class="error"></p>

    <h2>Món ăn</h2>
    <div class="table-scroll">
      <table id="monAnTable">
        <thead><tr><th>Tên món</th><th>Giá</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <form id="monAnAddForm" class="hidden">
      <label>Tên món ăn mới <input type="text" name="name" required maxlength="200" /></label>
      <label>Nhóm <input type="text" name="subgroup" list="monAnSubgroupList" maxlength="100" /></label>
      <datalist id="monAnSubgroupList"></datalist>
      <label>Giá (đ) <input type="number" name="price" min="1" step="1" required /></label>
      <label>Đơn vị <input type="text" name="unit" maxlength="100" /></label>
      <label class="checkbox-label"><input type="checkbox" name="requiresPreorder" /> Cần đặt trước</label>
      <button type="submit">+ Thêm món</button>
      <p id="monAnAddError" class="error"></p>
    </form>

    <h2>Thức uống</h2>
    <div class="table-scroll">
      <table id="doUongTable">
        <thead><tr><th>Tên món</th><th>Giá</th><th>Trạng thái</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </div>
    <form id="doUongAddForm" class="hidden">
      <label>Tên thức uống mới <input type="text" name="name" required maxlength="200" /></label>
      <label>Nhóm <input type="text" name="subgroup" list="doUongSubgroupList" maxlength="100" /></label>
      <datalist id="doUongSubgroupList"></datalist>
      <label>Giá (đ) <input type="number" name="price" min="1" step="1" required /></label>
      <label>Đơn vị <input type="text" name="unit" maxlength="100" /></label>
      <button type="submit">+ Thêm thức uống</button>
      <p id="doUongAddError" class="error"></p>
    </form>
  </div>

  <script src="/admin/dine-in-menu.js"></script>
  <script src="/admin/nav-drawer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Viết lại JS**

Thay toàn bộ nội dung `v4/admin/dine-in-menu.js`:

```js
// v4/admin/dine-in-menu.js
let currentRole = null;
let menuItems = [];

(async () => {
  let res;
  try {
    res = await fetch('/api/auth/me');
  } catch (err) {
    window.location.href = '/admin';
    return;
  }
  if (!res.ok) {
    window.location.href = '/admin';
    return;
  }
  const { role } = await res.json();
  currentRole = role;

  if (currentRole === 'admin') {
    document.getElementById('monAnAddForm').classList.remove('hidden');
    document.getElementById('doUongAddForm').classList.remove('hidden');
  }

  await loadMenu();
})();

async function loadMenu() {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  let response;
  try {
    response = await fetch('/api/dine-in-menu');
  } catch (err) {
    errorEl.textContent = 'Có lỗi khi tải menu';
    return;
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi tải menu';
    return;
  }
  menuItems = await response.json();
  renderTable('mon_an', document.querySelector('#monAnTable tbody'));
  renderTable('do_uong', document.querySelector('#doUongTable tbody'));
  populateSubgroupDatalist('mon_an', document.getElementById('monAnSubgroupList'));
  populateSubgroupDatalist('do_uong', document.getElementById('doUongSubgroupList'));
}

function populateSubgroupDatalist(category, datalistEl) {
  datalistEl.innerHTML = '';
  const seen = new Set();
  menuItems.filter((m) => m.category === category && m.subgroup).forEach((m) => {
    if (seen.has(m.subgroup)) return;
    seen.add(m.subgroup);
    const option = document.createElement('option');
    option.value = m.subgroup;
    datalistEl.appendChild(option);
  });
}

function groupByOrder(category) {
  const groupOrder = [];
  const groups = {};
  menuItems.filter((m) => m.category === category).forEach((m) => {
    const key = m.subgroup || '';
    if (!(key in groups)) {
      groups[key] = [];
      groupOrder.push(key);
    }
    groups[key].push(m);
  });
  return { groupOrder, groups };
}

function renderTable(category, tbody) {
  tbody.innerHTML = '';
  const { groupOrder, groups } = groupByOrder(category);
  const isMonAn = category === 'mon_an';

  groupOrder.forEach((subgroup, groupIndex) => {
    if (subgroup) {
      const headerRow = document.createElement('tr');
      const headerCell = document.createElement('td');
      headerCell.colSpan = 4;
      headerCell.style.fontWeight = '600';
      headerCell.append(subgroup + ' ');

      if (currentRole === 'admin') {
        const upGroupBtn = document.createElement('button');
        upGroupBtn.type = 'button';
        upGroupBtn.className = 'btn-secondary';
        upGroupBtn.textContent = '▲';
        upGroupBtn.disabled = groupIndex === 0;
        upGroupBtn.addEventListener('click', () => moveGroupHandler(category, subgroup, 'up'));
        const downGroupBtn = document.createElement('button');
        downGroupBtn.type = 'button';
        downGroupBtn.className = 'btn-secondary';
        downGroupBtn.textContent = '▼';
        downGroupBtn.disabled = groupIndex === groupOrder.length - 1;
        downGroupBtn.addEventListener('click', () => moveGroupHandler(category, subgroup, 'down'));
        headerCell.append(upGroupBtn, downGroupBtn);
      }

      headerRow.appendChild(headerCell);
      tbody.appendChild(headerRow);
    }

    const items = groups[subgroup];
    items.forEach((m, itemIndex) => {
      const tr = document.createElement('tr');
      if (!m.isActive) tr.style.opacity = '0.5';

      const tdName = document.createElement('td');
      tdName.textContent = m.name;

      const tdPrice = document.createElement('td');
      const unitSuffix = m.unit ? `/${m.unit}` : '';
      tdPrice.textContent = `${m.price.toLocaleString('vi-VN')}đ${unitSuffix}`;
      if (isMonAn && m.requiresPreorder) {
        const badge = document.createElement('span');
        badge.textContent = ' ⚠ Đặt trước';
        tdPrice.appendChild(badge);
      }

      const tdStatus = document.createElement('td');
      tdStatus.textContent = m.isActive ? 'Đang bán' : 'Đã ẩn';

      const tdActions = document.createElement('td');
      if (currentRole === 'admin') {
        const upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.className = 'btn-secondary';
        upBtn.textContent = '▲';
        upBtn.disabled = itemIndex === 0;
        upBtn.addEventListener('click', () => moveItemHandler(m.id, 'up'));
        const downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.className = 'btn-secondary';
        downBtn.textContent = '▼';
        downBtn.disabled = itemIndex === items.length - 1;
        downBtn.addEventListener('click', () => moveItemHandler(m.id, 'down'));
        const editBtn = document.createElement('button');
        editBtn.type = 'button';
        editBtn.textContent = 'Sửa';
        editBtn.addEventListener('click', () => editItem(m));
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = 'btn-secondary';
        toggleBtn.textContent = m.isActive ? 'Ẩn' : 'Hiện lại';
        toggleBtn.addEventListener('click', () => toggleActive(m));
        tdActions.append(upBtn, downBtn, editBtn, toggleBtn);

        if (isMonAn) {
          const preorderBtn = document.createElement('button');
          preorderBtn.type = 'button';
          preorderBtn.className = 'btn-secondary';
          preorderBtn.textContent = m.requiresPreorder ? 'Bỏ đặt trước' : 'Cần đặt trước';
          preorderBtn.addEventListener('click', () => togglePreorder(m));
          tdActions.append(preorderBtn);
        }
      }

      tr.append(tdName, tdPrice, tdStatus, tdActions);
      tbody.appendChild(tr);
    });
  });
}

async function moveItemHandler(itemId, direction) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  const response = await fetch(`/api/dine-in-menu/${itemId}/move`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi đổi thứ tự món';
    return;
  }
  await loadMenu();
}

async function moveGroupHandler(category, subgroup, direction) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  const response = await fetch('/api/dine-in-menu/move-group', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, subgroup, direction }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi đổi thứ tự nhóm';
    return;
  }
  await loadMenu();
}

async function editItem(item) {
  const newName = window.prompt('Tên món mới:', item.name);
  if (newName === null) return;
  const trimmedName = newName.trim();
  if (!trimmedName) return;

  const newPriceStr = window.prompt('Giá mới (đ):', String(item.price));
  if (newPriceStr === null) return;
  const newPrice = Number(newPriceStr);
  const errorEl = document.getElementById('pageError');
  if (!Number.isInteger(newPrice) || newPrice <= 0) {
    errorEl.textContent = 'Giá không hợp lệ';
    return;
  }

  const newSubgroupStr = window.prompt('Nhóm (để trống nếu không có):', item.subgroup || '');
  if (newSubgroupStr === null) return;

  const newUnitStr = window.prompt('Đơn vị (để trống nếu không có):', item.unit || '');
  if (newUnitStr === null) return;

  errorEl.textContent = '';
  const response = await fetch(`/api/dine-in-menu/${item.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: trimmedName, price: newPrice, subgroup: newSubgroupStr.trim() || null, unit: newUnitStr.trim() || null }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi sửa món';
    return;
  }
  await loadMenu();
}

async function toggleActive(item) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  const response = await fetch(`/api/dine-in-menu/${item.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isActive: !item.isActive }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi cập nhật món';
    return;
  }
  await loadMenu();
}

async function togglePreorder(item) {
  const errorEl = document.getElementById('pageError');
  errorEl.textContent = '';
  const response = await fetch(`/api/dine-in-menu/${item.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requiresPreorder: !item.requiresPreorder }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    errorEl.textContent = body.error || 'Có lỗi khi cập nhật cờ đặt trước';
    return;
  }
  await loadMenu();
}

function wireAddForm(formId, errorId, category, includePreorder) {
  const form = document.getElementById(formId);
  const errorEl = document.getElementById(errorId);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const name = form.querySelector('[name="name"]').value.trim();
    const subgroup = form.querySelector('[name="subgroup"]').value.trim();
    const price = Number(form.querySelector('[name="price"]').value);
    const unit = form.querySelector('[name="unit"]').value.trim();
    const requiresPreorder = includePreorder ? form.querySelector('[name="requiresPreorder"]').checked : false;
    if (!name) {
      errorEl.textContent = 'Vui lòng nhập tên món';
      return;
    }
    if (!Number.isInteger(price) || price <= 0) {
      errorEl.textContent = 'Vui lòng nhập giá hợp lệ';
      return;
    }
    const response = await fetch('/api/dine-in-menu', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, category, price, subgroup: subgroup || undefined, unit: unit || undefined, requiresPreorder }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorEl.textContent = body.error || 'Có lỗi khi thêm món';
      return;
    }
    form.reset();
    await loadMenu();
  });
}

wireAddForm('monAnAddForm', 'monAnAddError', 'mon_an', true);
wireAddForm('doUongAddForm', 'doUongAddError', 'do_uong', false);
```

- [ ] **Step 3: Kiểm tra thủ công**

Từ `v4/`: `npx http-server . -p 8899 -s -c-1` (chạy nền). Mở trình duyệt thật (không chỉ curl) tới `http://localhost:8899/admin/dine-in-menu.html` — sẽ chuyển hướng về `/admin` vì không có session thật (đúng như mong đợi, xác nhận code không có lỗi cú pháp/parse). Dừng server sau khi kiểm tra.

- [ ] **Step 4: Commit**

```bash
cd v4
git add admin/dine-in-menu.html admin/dine-in-menu.js
git commit -m "feat: rework Menu quán UI for grouping, unit, preorder flag, and up/down reordering

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Retrofit — trang chọn món ở Order ăn uống (đã chạy production)

**Files:**
- Modify: `v4/admin/dine-in-order-detail.js`

**Interfaces:**
- Consumes: `GET /api/dine-in-menu` với field mới `subgroup`, `unit`, `requiresPreorder` (Task 3).

- [ ] **Step 1: Sửa `populateMenuSelect`**

Trong `v4/admin/dine-in-order-detail.js`, thay toàn bộ hàm `populateMenuSelect`:

```js
function populateMenuSelect() {
  const select = document.querySelector('#addItemForm select[name="menuItemId"]');
  select.innerHTML = '<option value="">-- Chọn món --</option>';

  ['mon_an', 'do_uong'].forEach((category) => {
    const groupOrder = [];
    const groups = {};
    menuItems.filter((m) => m.category === category).forEach((m) => {
      const key = m.subgroup || (category === 'mon_an' ? 'Món ăn khác' : 'Thức uống khác');
      if (!(key in groups)) {
        groups[key] = [];
        groupOrder.push(key);
      }
      groups[key].push(m);
    });

    groupOrder.forEach((key) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = key;
      groups[key].forEach((m) => {
        const option = document.createElement('option');
        option.value = m.id;
        const unitSuffix = m.unit ? `/${m.unit}` : '';
        const preorderSuffix = m.requiresPreorder ? ' ⚠ Đặt trước' : '';
        option.textContent = `${m.name} — ${m.price.toLocaleString('vi-VN')}đ${unitSuffix}${preorderSuffix}`;
        optgroup.appendChild(option);
      });
      select.appendChild(optgroup);
    });
  });
}
```

- [ ] **Step 2: Kiểm tra thủ công**

Từ `v4/`: `npx http-server . -p 8899 -s -c-1` (chạy nền). Mở trình duyệt thật tới `http://localhost:8899/admin/dine-in-order-detail.html?orderId=1` — sẽ chuyển hướng về `/admin` vì không có session thật (xác nhận không có lỗi cú pháp). Dừng server sau khi kiểm tra.

- [ ] **Step 3: Commit**

```bash
cd v4
git add admin/dine-in-order-detail.js
git commit -m "feat: retrofit Order ăn uống item picker to group by dine-in-menu subgroup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Retrofit — file plan Giờ Xanh Hiền Lê (chưa triển khai)

**Files:**
- Modify: `docs/superpowers/plans/2026-09-04-gio-xanh-sessions.md` (outer repo — `D:\VDX\HienLeGarden\LandingPage`, KHÔNG phải `v4/`)

**Interfaces:**
- Không sản sinh interface nào — chỉ sửa văn bản plan để khớp schema mới trước khi plan đó được dispatch.

Plan Giờ Xanh Hiền Lê chưa có task nào được thực thi (không có commit nào liên quan tồn tại), nên đây là sửa trực tiếp file `.md`, không phải sửa code đã chạy.

- [ ] **Step 1: Đổi số migration từ 0022 sang 0023 (tránh trùng với Task 1 của plan này)**

Trong `docs/superpowers/plans/2026-09-04-gio-xanh-sessions.md`, tìm và thay **toàn bộ** các chỗ xuất hiện (dùng tìm-thay toàn văn bản, cả trong đoạn văn mô tả lẫn trong khối code):
- `0022_gio_xanh_sessions.sql` → `0023_gio_xanh_sessions.sql`
- `migration 0022` → `migration 0023`
- `migration này lấy số 0022` → `migration này lấy số 0023` (nếu có câu tương tự)

(Các chỗ này xuất hiện ở: Global Constraints nếu có nhắc số migration, tên file trong Task 1's "Files" block, nội dung Step 1 tạo migration, đường dẫn trong lệnh `git add`, thông điệp trong `deploy checklist` cuối file nếu có nhắc `0022`.)

- [ ] **Step 2: Cập nhật `populateMenuSelect()` trong Task 6 của plan Giờ Xanh để khớp schema menu mới**

Trong `docs/superpowers/plans/2026-09-04-gio-xanh-sessions.md`, Task 6, tìm khối code JS chứa hàm `populateMenuSelect()` (trong phần code của `admin/gio-xanh-detail.js`) — hiện đang là:

```js
function populateMenuSelect() {
  const select = document.querySelector('#addMenuItemForm select[name="menuItemId"]');
  select.innerHTML = '<option value="">-- Chọn món --</option>';
  const groups = { mon_an: 'Món ăn', do_uong: 'Thức uống' };
  Object.entries(groups).forEach(([category, label]) => {
    const items = menuItems.filter((m) => m.category === category);
    if (items.length === 0) return;
    const optgroup = document.createElement('optgroup');
    optgroup.label = label;
    items.forEach((m) => {
      const option = document.createElement('option');
      option.value = m.id;
      option.textContent = `${m.name} — ${m.price.toLocaleString('vi-VN')}đ`;
      optgroup.appendChild(option);
    });
    select.appendChild(optgroup);
  });
}
```

Thay bằng (nhóm động theo `subgroup`, đơn vị + cảnh báo đặt trước):

```js
function populateMenuSelect() {
  const select = document.querySelector('#addMenuItemForm select[name="menuItemId"]');
  select.innerHTML = '<option value="">-- Chọn món --</option>';

  ['mon_an', 'do_uong'].forEach((category) => {
    const groupOrder = [];
    const groups = {};
    menuItems.filter((m) => m.category === category).forEach((m) => {
      const key = m.subgroup || (category === 'mon_an' ? 'Món ăn khác' : 'Thức uống khác');
      if (!(key in groups)) {
        groups[key] = [];
        groupOrder.push(key);
      }
      groups[key].push(m);
    });

    groupOrder.forEach((key) => {
      const optgroup = document.createElement('optgroup');
      optgroup.label = key;
      groups[key].forEach((m) => {
        const option = document.createElement('option');
        option.value = m.id;
        const unitSuffix = m.unit ? `/${m.unit}` : '';
        const preorderSuffix = m.requiresPreorder ? ' ⚠ Đặt trước' : '';
        option.textContent = `${m.name} — ${m.price.toLocaleString('vi-VN')}đ${unitSuffix}${preorderSuffix}`;
        optgroup.appendChild(option);
      });
      select.appendChild(optgroup);
    });
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-09-04-gio-xanh-sessions.md
git commit -m "docs: renumber gio-xanh migration to 0023, retrofit menu picker for new subgroup schema

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

(Chạy `git add`/`git commit` từ thư mục gốc outer repo, KHÔNG phải từ `v4/`.)

---

### Task 8: E2e coverage (outer repo)

**Files:**
- Create: `LandingPage/tests/e2e/dine-in-menu-groups.spec.js` (outer repo)

**Interfaces:**
- Consumes: DOM contract của `admin/dine-in-menu.html`/`.js` (Task 5).

- [ ] **Step 1: Viết e2e test**

Tạo `tests/e2e/dine-in-menu-groups.spec.js` (outer repo):

```js
// tests/e2e/dine-in-menu-groups.spec.js
const { test, expect } = require('@playwright/test');

function mockAuth(page, role) {
  return page.route('**/api/auth/me', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ username: 'admin_a', role }) }));
}

function menuItem(overrides) {
  return {
    id: 1, name: 'Gỏi hải sản', category: 'mon_an', price: 179000, subgroup: 'Hải sản', unit: 'đĩa', requiresPreorder: false,
    displayOrder: 0, isActive: true, updatedBy: 'admin', updatedAt: '2026-09-04T00:00:00Z',
    ...overrides,
  };
}

test.describe('Menu quán — grouping and reordering', () => {
  test('renders subgroup headers and shows unit + preorder badge', async ({ page }) => {
    await mockAuth(page, 'admin');
    const items = [
      menuItem({ id: 1, name: 'Gỏi hải sản', subgroup: 'Hải sản', unit: 'đĩa', displayOrder: 0 }),
      menuItem({ id: 2, name: 'Gà nướng', subgroup: 'Món gà', unit: 'con', requiresPreorder: true, displayOrder: 1 }),
    ];
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) }));

    await page.goto('/admin/dine-in-menu.html');
    await expect(page.locator('#monAnTable')).toContainText('Hải sản');
    await expect(page.locator('#monAnTable')).toContainText('Món gà');
    await expect(page.locator('#monAnTable')).toContainText('179.000đ/đĩa');
    await expect(page.locator('#monAnTable')).toContainText('⚠ Đặt trước');
  });

  test('clicking the group ▼ button calls move-group with the right payload', async ({ page }) => {
    await mockAuth(page, 'admin');
    const items = [
      menuItem({ id: 1, name: 'Gỏi hải sản', subgroup: 'Hải sản', displayOrder: 0 }),
      menuItem({ id: 2, name: 'Gà nướng', subgroup: 'Món gà', displayOrder: 1 }),
    ];
    await page.route('**/api/dine-in-menu', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    });
    let moveGroupBody = null;
    await page.route('**/api/dine-in-menu/move-group', (route) => {
      moveGroupBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/dine-in-menu.html');
    const groupHeaderRow = page.locator('#monAnTable tr', { hasText: 'Hải sản' }).first();
    await groupHeaderRow.locator('button', { hasText: '▼' }).click();

    await expect.poll(() => moveGroupBody).toMatchObject({ category: 'mon_an', subgroup: 'Hải sản', direction: 'down' });
  });

  test('clicking an item ▲ button calls the move endpoint for that item', async ({ page }) => {
    await mockAuth(page, 'admin');
    const items = [
      menuItem({ id: 1, name: 'Gỏi hải sản', subgroup: 'Hải sản', displayOrder: 0 }),
      menuItem({ id: 2, name: 'Tôm sốt', subgroup: 'Hải sản', displayOrder: 1 }),
    ];
    await page.route('**/api/dine-in-menu', (route) => {
      if (route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) });
    });
    let moveUrl = null;
    let moveBody = null;
    await page.route('**/api/dine-in-menu/2/move', (route) => {
      moveUrl = route.request().url();
      moveBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });

    await page.goto('/admin/dine-in-menu.html');
    const itemRow = page.locator('#monAnTable tr', { hasText: 'Tôm sốt' });
    await itemRow.locator('button', { hasText: '▲' }).click();

    await expect.poll(() => moveBody).toMatchObject({ direction: 'up' });
    expect(moveUrl).toContain('/api/dine-in-menu/2/move');
  });

  test('drinks table also groups by subgroup and shows unit, but never a preorder badge', async ({ page }) => {
    await mockAuth(page, 'admin');
    const items = [menuItem({ id: 3, name: 'Cà phê đen', category: 'do_uong', subgroup: 'Cà phê', unit: 'ly', price: 25000, requiresPreorder: false, displayOrder: 0 })];
    await page.route('**/api/dine-in-menu', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(items) }));

    await page.goto('/admin/dine-in-menu.html');
    await expect(page.locator('#doUongTable')).toContainText('Cà phê');
    await expect(page.locator('#doUongTable')).toContainText('25.000đ/ly');
    await expect(page.locator('#doUongTable')).not.toContainText('Đặt trước');
  });
});
```

- [ ] **Step 2: Chạy spec mới**

Từ `LandingPage/` (outer repo root): `npx playwright test tests/e2e/dine-in-menu-groups.spec.js --project=v4`
Expected: PASS — 4/4.

- [ ] **Step 3: Chạy toàn bộ project v4 để kiểm tra hồi quy**

`npx playwright test --project=v4`
Expected: PASS — toàn bộ test trong project v4, bao gồm spec mới và mọi spec trước đó.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/dine-in-menu-groups.spec.js
git commit -m "test: e2e coverage for dine-in menu grouping and reordering

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Deploy checklist (sau khi toàn bộ task pass final review)

Mọi bước dưới đây cần xác nhận rõ ràng từ người dùng trước khi chạy — quy tắc chuẩn của dự án.

1. Áp dụng migration 0022 lên D1 production: `npx wrangler d1 migrations apply hien_le_garden_crm --remote` (từ `v4/`).
2. Push `v4` (branch `main`), xác nhận Cloudflare Pages deploy thành công.
3. Push outer repo (thêm e2e test + sửa file plan Giờ Xanh).
4. Smoke-test thực tế: vào "Menu quán", thêm 1 món ăn có nhóm/đơn vị/đặt trước, thêm món thứ 2 cùng nhóm, xác nhận nó xếp cuối nhóm; thử nút ▲▼ đổi thứ tự món và cả nhóm; xác nhận trang "Order ăn uống" hiển thị đúng nhóm/đơn vị/cảnh báo khi chọn món. Dọn sạch dữ liệu test sau khi xong.
