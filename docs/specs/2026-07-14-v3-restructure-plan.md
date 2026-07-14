# V3 Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `v3/index.html` and add a new `v3/bang-gia/index.html` page so the site matches the architecture agreed in `docs/specs/2026-07-14-v3-restructure-design.md`.

**Architecture:** This is a no-build, single-file-per-page static site (plain HTML/CSS/JS, no framework, no test runner). There is no automated test suite, so every task's "test" step is a `grep`/`diff` shell command that shows the current (wrong) state before the edit and the corrected state after — the same red/green discipline as unit tests, just applied to markup instead of code.

**Tech Stack:** HTML5, CSS custom properties, vanilla JS. No build step.

## Global Constraints

- Repo: `/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3` (its own git repo, remote `github.com:Panther8386/hien-le-garden-v3.git`, branch `main`).
- Only `v3/` is touched. Never edit `v1/` or `v2/` in this plan.
- Hotline everywhere: **0968 987 311**. Facebook page: `https://www.facebook.com/p/Hi%E1%BB%81n-L%C3%AA-Garden-61556329706262/`. Google Maps place: `https://www.google.com/maps/place/?ftid=0x3173b9d965e948e9:0x515283da634ab176`. Zalo: `https://zalo.me/0968987311`.
- Do not fabricate customer names, quotes, star ratings, or dates. Only real, verifiable links are allowed as "sources."
- Commit after every task (small, reviewable commits). Do not push until Task 8 (final verification) passes.
- Vietnamese is the primary language for all new/edited copy.

---

### Task 1: Remove the Amenities section, its CSS, and repoint dead links

**Files:**
- Modify: `v3/index.html`

**Interfaces:** None (pure markup/CSS removal within one file).

- [ ] **Step 1: Verify current state (this is the "failing test")**

Run:
```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'id="amenities"' index.html && grep -c '#amenities' index.html
```
Expected: `2` (one `<section>` opening tag, one CSS `#amenities {` rule) and `8` (1 desktop nav link + 1 mobile nav link + 6 footer "Dịch Vụ" links).

- [ ] **Step 2: Remove the Amenities `<section>` from the HTML body**

Delete this exact block (including the preceding HTML comment header):

```html
  <!-- ============================================
       5. TIỆN ÍCH
  ============================================ -->
  <section class="section" id="amenities">
    <div class="container">
      <div class="section-header fade-in">
        <span class="label">Giá Trị · Values</span>
        <h2>Mỗi Buổi Sáng Đều Đáng Để Thức Dậy.</h2>
        <p>Chúng tôi không chỉ cung cấp tiện ích — chúng tôi gìn giữ những điều nhỏ bé khiến một buổi sáng trở nên thật sự đáng nhớ.</p>
      </div>
      <div class="amenities-grid">
        <div class="amenity-card fade-in">
          <span class="amenity-icon">🏔️</span>
          <div class="amenity-name">View Hồ Panorama</div>
          <div class="amenity-desc">Tầm nhìn 180° ra hồ thơ mộng — điểm check-in hot nhất Lâm Đồng</div>
        </div>
        <div class="amenity-card fade-in">
          <span class="amenity-icon">🌸</span>
          <div class="amenity-name">Vườn Hoa Cỏ May</div>
          <div class="amenity-desc">Bãi hoa cỏ may rực rỡ theo mùa - khung cảnh nên thơ lý tưởng cho ảnh cưới & check-in.</div>
        </div>
        <div class="amenity-card fade-in">
          <span class="amenity-icon">🔥</span>
          <div class="amenity-name">Campfire & Glamping</div>
          <div class="amenity-desc">Đốt lửa trại, cắm trại qua đêm dưới bầu trời đầy sao</div>
        </div>
        <div class="amenity-card fade-in">
          <span class="amenity-icon">☕</span>
          <div class="amenity-name">Cà Phê Giữa Vườn</div>
          <div class="amenity-desc">Thưởng thức cà phê Ban Mê giữa không gian xanh mát</div>
        </div>
        <div class="amenity-card fade-in">
          <span class="amenity-icon">👥</span>
          <div class="amenity-name">Team Building</div>
          <div class="amenity-desc">Tổ chức sự kiện, team building từ 20–100 người với đầy đủ tiện nghi</div>
        </div>
        <div class="amenity-card fade-in">
          <span class="amenity-icon">📸</span>
          <div class="amenity-name">Không gian chụp ảnh giữa thiên nhiên</div>
          <div class="amenity-desc">Hàng chục góc check-in độc đáo với phong cảnh thiên nhiên</div>
        </div>
        <div class="amenity-card fade-in">
          <span class="amenity-icon">🌱</span>
          <div class="amenity-name">Nông Nghiệp Trải Nghiệm</div>
          <div class="amenity-desc">Trồng rau, hái trái cây, trải nghiệm nông nghiệp sạch</div>
        </div>
        <div class="amenity-card fade-in">
          <span class="amenity-icon">🎠</span>
          <div class="amenity-name">Khu Vui Chơi Trẻ Em</div>
          <div class="amenity-desc">Khu vui chơi an toàn miễn phí cho bé, ba mẹ thư giãn</div>
        </div>
      </div>
    </div>
  </section>

  <!-- ============================================
       6. TIMELINE TRẢI NGHIỆM
  ============================================ -->
```

Replace it with just:

```html
  <!-- ============================================
       6. TIMELINE TRẢI NGHIỆM
  ============================================ -->
```

(i.e. delete the amenities comment+section, keep the timeline comment that follows it).

- [ ] **Step 3: Remove the dead `.amenities-grid`/`.amenity-*` CSS block**

Delete this exact block from the `<style>` section:

```css
    /* ============================================
       6. TIỆN ÍCH
    ============================================ */
    #amenities {
      background: var(--bg-primary);
    }
    .amenities-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 2rem;
    }
    .amenity-card {
      text-align: center;
      padding: 2rem 1rem;
      border-radius: var(--radius-md);
      border: 1px solid var(--border-subtle);
      background: var(--bg-surface);
      transition: border-color var(--transition), box-shadow var(--transition);
    }
    .amenity-card:hover {
      border-color: var(--accent-gold);
      box-shadow: 0 8px 24px rgba(26,83,58,0.08);
    }
    .amenity-icon {
      font-size: 2.2rem;
      margin-bottom: 1rem;
      display: block;
    }
    .amenity-name {
      font-family: var(--font-serif);
      font-size: 1.05rem;
      font-style: italic;
      color: var(--text-primary);
      margin-bottom: 0.35rem;
    }
    .amenity-desc { font-size: 0.78rem; color: var(--text-muted); line-height: 1.5; }

    @media (max-width: 1024px) { .amenities-grid { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 480px) { .amenities-grid { grid-template-columns: repeat(2, 1fr); gap: 1rem; } }

    /* ============================================
       7. TIMELINE TRẢI NGHIỆM
    ============================================ */
```

Replace with just:

```css
    /* ============================================
       7. TIMELINE TRẢI NGHIỆM
    ============================================ */
```

- [ ] **Step 4: Remove the "Tiện Ích" nav link (desktop)**

In the `<ul class="nav-links">` block, delete this line:
```html
      <li><a href="#amenities">Tiện Ích</a></li>
```

- [ ] **Step 5: Remove the "Tiện Ích" nav link (mobile)**

In the `<div class="nav-mobile-overlay">` block, delete this line:
```html
    <a href="#amenities">Tiện Ích</a>
```

- [ ] **Step 6: Repoint the footer "Dịch Vụ" column from `#amenities` to the new pricing page**

Find:
```html
      <div>
        <div class="footer-heading">Dịch Vụ</div>
        <ul class="footer-links">
          <li><a href="#amenities">Campfire & Glamping</a></li>
          <li><a href="#amenities">Team Building</a></li>
          <li><a href="#amenities">Cà Phê Vườn</a></li>
          <li><a href="#amenities">Nông Nghiệm</a></li>
          <li><a href="#amenities">Khu Vui Chơi</a></li>
          <li><a href="#amenities">Không gian chụp ảnh giữa thiên nhiên</a></li>
        </ul>
      </div>
```

Replace with (these services are now priced in detail on the new Bảng Giá page, so point there instead of a removed anchor):
```html
      <div>
        <div class="footer-heading">Dịch Vụ</div>
        <ul class="footer-links">
          <li><a href="bang-gia/">Campfire & Glamping</a></li>
          <li><a href="bang-gia/">Team Building</a></li>
          <li><a href="bang-gia/">Cà Phê Vườn</a></li>
          <li><a href="bang-gia/">Nông Nghiệm</a></li>
          <li><a href="bang-gia/">Khu Vui Chơi</a></li>
          <li><a href="bang-gia/">Không gian chụp ảnh giữa thiên nhiên</a></li>
        </ul>
      </div>
```

(This link will 404 until Task 6 creates the page — that's fine, it's fixed before Task 8's final push.)

- [ ] **Step 7: Verify (this is the "passing test")**

Run:
```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'id="amenities"' index.html; grep -c '#amenities' index.html; grep -c 'amenities-grid' index.html
```
Expected: all three commands print `0`.

- [ ] **Step 8: Commit**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && git add index.html && git commit -m "refactor(V3): remove Amenities section, covered by cẩm nang/bảng giá pages"
```

---

### Task 2: Swap the booking form to V2's compact version

**Files:**
- Modify: `v3/index.html`

**Interfaces:** Removes `checkAvailability()`; adds `handleBooking()` (same signature/behavior as in `v2/index.html`). `openBookingModal()`/`submitBooking()` (the separate popup modal) are untouched — they don't call `checkAvailability` or `handleBooking`.

- [ ] **Step 1: Verify current state**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'checkAvailability\|availCheckBtn\|availStatus' index.html
```
Expected: `4` (1 button id/onclick reference in HTML, 1 function definition, plus internal references — exact count isn't the point, just confirm it's non-zero).

- [ ] **Step 2: Replace the booking section markup**

Find:
```html
      <button class="booking-submit" id="availCheckBtn" onclick="checkAvailability()">Gửi Yêu Cầu Kiểm Tra Phòng →</button>
    </div>
    <div class="container" style="padding-top:0; padding-bottom:0.5rem;">
      <div id="availStatus" style="display:none;"></div>
    </div>
  </section>
```

Replace with:
```html
      <button class="booking-submit" onclick="handleBooking()">Gửi Yêu Cầu Kiểm Tra Phòng →</button>
    </div>
  </section>
```

- [ ] **Step 3: Replace the `checkAvailability()` JS function with `handleBooking()`**

Find (the full function, lines starting at `function checkAvailability()`):
```js
    function checkAvailability() {
      const checkIn  = document.getElementById('checkIn').value;
      const checkOut = document.getElementById('checkOut').value;
      const room     = document.getElementById('roomType').value;
      const statusEl = document.getElementById('availStatus');
      if (!room) {
        statusEl.style.display = 'flex';
        statusEl.className = 'avail-status avail-checking';
        statusEl.innerHTML = '<span class="avail-dot"></span>Vui lòng chọn loại phòng để kiểm tra';
        return;
      }
      // Show checking state
      statusEl.style.display = 'flex';
      statusEl.className = 'avail-status avail-checking';
      statusEl.innerHTML = '<span class="avail-dot"></span>Đang kiểm tra phòng trống...';
      // Simulate network latency
      setTimeout(() => {
        const ci = checkIn ? new Date(checkIn) : new Date();
        const dow = ci.getDay();
        const isWeekend = dow === 5 || dow === 6 || dow === 0;
        const isHoliday = [/* peak dates */].some(d => ci.toISOString().startsWith(d));
        if (isHoliday || (isWeekend && Math.random() > 0.35)) {
          statusEl.className = 'avail-status avail-limited';
          statusEl.innerHTML = '<span class="avail-dot"></span>Còn 1–2 phòng — Đặt sớm để giữ chỗ! <a href="https://zalo.me/0968987311" target="_blank" rel="noopener" style="margin-left:8px;color:inherit;text-decoration:underline">Xác nhận qua Zalo →</a>';
        } else {
          statusEl.className = 'avail-status avail-available';
          statusEl.innerHTML = '<span class="avail-dot"></span>Còn phòng trống — Đặt ngay để nhận giá tốt nhất! <button onclick="openBookingModal()" style="margin-left:8px;background:none;border:none;color:inherit;text-decoration:underline;cursor:pointer;font:inherit">Đặt phòng →</button>';
        }
      }, 900);
    }
```

Replace with:
```js
    function handleBooking() {
      const checkIn = document.getElementById('checkIn').value;
      const checkOut = document.getElementById('checkOut').value;
      const room = document.getElementById('roomType').value;
      if (!room) { alert('Vui lòng chọn loại phòng!'); return; }
      const msg = `Xin chào! Tôi muốn đặt phòng:\n- Phòng: ${room}\n- Nhận: ${checkIn}\n- Trả: ${checkOut}\nVui lòng xác nhận giúp tôi. Cảm ơn!`;
      window.open(`https://www.facebook.com/p/Hi%E1%BB%81n-L%C3%AA-Garden-61556329706262/`, '_blank');
    }
```

- [ ] **Step 4: Remove the now-dead `.avail-*` CSS block**

Find:
```css
    /* ============================================
       V3 — BOOKING AVAILABILITY
    ============================================ */
    .avail-status {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      padding: 0.75rem 1rem;
      border-radius: 10px;
      font-size: 0.85rem;
      font-weight: 500;
      margin-top: 0.75rem;
      transition: all 0.3s ease;
    }
    .avail-available { background: rgba(16,185,129,0.1); color: #059669; border: 1px solid rgba(16,185,129,0.3); }
    .avail-limited   { background: rgba(245,158,11,0.1); color: #D97706; border: 1px solid rgba(245,158,11,0.3); }
    .avail-full      { background: rgba(239,68,68,0.1);  color: #DC2626; border: 1px solid rgba(239,68,68,0.3); }
    .avail-checking  { background: var(--bg-secondary); color: var(--text-muted); border: 1px solid var(--border-subtle); }
    .avail-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .avail-available .avail-dot { background: #10B981; animation: pulse 1.5s infinite; }
    .avail-limited .avail-dot   { background: #F59E0B; }
    .avail-full .avail-dot      { background: #EF4444; }
    .avail-checking .avail-dot  { background: var(--text-dim); animation: pulse 0.8s infinite; }
    @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.35} }

    /* ============================================
       WEATHER FX — Floating Animation
    ============================================ */
```

Replace with just:
```css
    /* ============================================
       WEATHER FX — Floating Animation
    ============================================ */
```

(Note: a separate `@keyframes pulse` already exists earlier in the file at the `.weather`-related block and is used elsewhere — do not remove that one, only this duplicate.)

- [ ] **Step 5: Verify**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'checkAvailability\|availCheckBtn\|availStatus\|avail-status\|avail-dot' index.html; grep -c 'function handleBooking' index.html
```
Expected: first command prints `0`, second prints `1`.

- [ ] **Step 6: Commit**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && git add index.html && git commit -m "refactor(V3): restore V2's compact booking form, drop fake availability check"
```

---

### Task 3: Sync the Rooms section copy to match V2 exactly

**Files:**
- Modify: `v3/index.html`

**Interfaces:** None (copy-only changes, no markup structure change).

- [ ] **Step 1: Verify current state (V3-only wording still present)**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'phù hợp check-in sống ảo\|Premium Private Stay\|view hồ panorama tuyệt đỉnh\|Full amenities' index.html
```
Expected: `4`.

- [ ] **Step 2: Apply the 4 copy edits**

| Old (V3) | New (V2) |
|---|---|
| `<p class="room-desc">Kiến trúc tam giác độc đáo, không gian xanh mát, phù hợp check-in sống ảo.</p>` | `<p class="room-desc">Kiến trúc tam giác độc đáo, không gian xanh mát, lưu lại những khoảnh khắc tự nhiên.</p>` |
| `<div class="room-name-en">Premium Private Stay</div>` | `<div class="room-name-en">Không gian riêng tư bên vườn</div>` |
| `<p class="room-desc">Không gian riêng tư, sân hiên rộng, view hồ panorama tuyệt đỉnh.</p>` | `<p class="room-desc">Không gian riêng tư, sân hiên rộng, tầm nhìn rộng mở ra hồ và khu vườn.</p>` |
| `<span class="room-meta-item">🏠 Full amenities</span>` | `<span class="room-meta-item">🏠 Không gian rộng rãi cho gia đình</span>` |

- [ ] **Step 3: Verify**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'phù hợp check-in sống ảo\|Premium Private Stay\|view hồ panorama tuyệt đỉnh\|Full amenities' index.html; grep -c 'lưu lại những khoảnh khắc tự nhiên\|Không gian riêng tư bên vườn\|tầm nhìn rộng mở ra hồ và khu vườn\|Không gian rộng rãi cho gia đình' index.html
```
Expected: first prints `0`, second prints `4`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && git add index.html && git commit -m "fix(V3): sync Rooms section copy to match V2 exactly"
```

---

### Task 4: Hide the (fake-data) Events section

**Files:**
- Modify: `v3/index.html`

**Interfaces:** None.

- [ ] **Step 1: Verify current state**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -n '<section class="section" id="events">' index.html
```
Expected: one line, without `style="display:none"`.

- [ ] **Step 2: Hide it the same way `#ota` is hidden**

Find:
```html
  <section class="section" id="events">
```

Replace with:
```html
  <section class="section" id="events" style="display:none">
```

- [ ] **Step 3: Verify**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -n '<section class="section" id="events"' index.html
```
Expected: `<section class="section" id="events" style="display:none">`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && git add index.html && git commit -m "fix(V3): hide Events section until real event data exists"
```

---

### Task 5: Redesign the Reviews section copy (remove fabricated attribution)

**Files:**
- Modify: `v3/index.html`

**Interfaces:** None. The 3 real outbound links (Facebook, Google Maps, Zalo) and the bottom CTA row are unchanged.

- [ ] **Step 1: Verify current state**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'Hường Trần\|Minh Tuấn Lê\|Thảo Nguyên' index.html
```
Expected: `3` (the fabricated names).

- [ ] **Step 2: Replace the Facebook card body**

Find:
```html
          <div class="rv-body">
            <div class="rv-stars">★★★★★</div>
            <p class="rv-text">"Không gian rất đẹp và yên tĩnh, view hồ cực chill. Chủ nhà thân thiện, nhiệt tình hướng dẫn. Sẽ quay lại lần sau cùng gia đình!"</p>
            <div class="rv-author-row">
              <div class="rv-avatar rv-avatar-fb">H</div>
              <div>
                <div class="rv-author">Hường Trần</div>
                <div class="rv-date">Facebook · Tháng 6, 2025</div>
              </div>
            </div>
          </div>
          <a href="https://www.facebook.com/p/Hi%E1%BB%81n-L%C3%AA-Garden-61556329706262/" target="_blank" rel="noopener noreferrer" class="rv-source-link">Xem đánh giá trên Facebook →</a>
```

Replace with:
```html
          <div class="rv-body">
            <p class="rv-text">Xem những chia sẻ và hình ảnh thật từ khách đã ghé Hiền Lê Garden trên trang Facebook chính thức.</p>
          </div>
          <a href="https://www.facebook.com/p/Hi%E1%BB%81n-L%C3%AA-Garden-61556329706262/" target="_blank" rel="noopener noreferrer" class="rv-source-link">Xem đánh giá trên Facebook →</a>
```

- [ ] **Step 3: Replace the Google Maps card body**

Find:
```html
          <div class="rv-body">
            <div class="rv-stars">★★★★★</div>
            <p class="rv-text">"Farmstay đẹp, nhiều kiểu phòng độc đáo. Mình ở Triangle House, buổi sáng nghe chim hót, không khí trong lành. Giá rất hợp lý so với chất lượng."</p>
            <div class="rv-author-row">
              <div class="rv-avatar rv-avatar-gg">M</div>
              <div>
                <div class="rv-author">Minh Tuấn Lê</div>
                <div class="rv-date">Google Maps · Tháng 4, 2025</div>
              </div>
            </div>
          </div>
          <a href="https://www.google.com/maps/place/?ftid=0x3173b9d965e948e9:0x515283da634ab176" target="_blank" rel="noopener noreferrer" class="rv-source-link">Xem đánh giá trên Google Maps →</a>
```

Replace with:
```html
          <div class="rv-body">
            <p class="rv-text">Đọc đánh giá và số sao thật từ khách lưu trú, cập nhật trực tiếp trên Google Maps.</p>
          </div>
          <a href="https://www.google.com/maps/place/?ftid=0x3173b9d965e948e9:0x515283da634ab176" target="_blank" rel="noopener noreferrer" class="rv-source-link">Xem đánh giá trên Google Maps →</a>
```

- [ ] **Step 4: Replace the Zalo card body**

Find:
```html
          <div class="rv-body">
            <div class="rv-stars">★★★★★</div>
            <p class="rv-text">"Mình đặt phòng Bungalow cho cả nhà 6 người, không gian rộng rãi, sạch sẽ. Bé con thích lắm vì có bãi cỏ rộng chạy nhảy. Cảm ơn chị chủ nhiệt tình ạ!"</p>
            <div class="rv-author-row">
              <div class="rv-avatar rv-avatar-zl">T</div>
              <div>
                <div class="rv-author">Thảo Nguyên</div>
                <div class="rv-date">Zalo · Tháng 3, 2025</div>
              </div>
            </div>
          </div>
          <a href="https://zalo.me/0968987311" target="_blank" rel="noopener noreferrer" class="rv-source-link">Nhắn tin / hỏi thêm qua Zalo →</a>
```

Replace with:
```html
          <div class="rv-body">
            <p class="rv-text">Nhắn trực tiếp qua Zalo để được tư vấn nhanh và xem thêm phản hồi từ khách đã từng đặt phòng.</p>
          </div>
          <a href="https://zalo.me/0968987311" target="_blank" rel="noopener noreferrer" class="rv-source-link">Nhắn tin / hỏi thêm qua Zalo →</a>
```

- [ ] **Step 5: Verify**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'Hường Trần\|Minh Tuấn Lê\|Thảo Nguyên\|rv-stars\|rv-author-row' index.html
```
Expected: `0`.

- [ ] **Step 6: Commit**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && git add index.html && git commit -m "fix(V3): remove fabricated review attribution, keep only real source links"
```

---

### Task 6: Create the new "Trang bảng giá" page

**Files:**
- Create: `v3/bang-gia/index.html`

**Interfaces:** Self-contained page (own `<style>`/`<script>`), no dependency on `index.html`'s CSS/JS. Follows the same structural pattern as `v3/cam-nang/10-diem-check-in/index.html` (sub-nav, page-hero, content-wrap, breadcrumb, sub-footer) but one directory level shallower (`bang-gia/` vs `cam-nang/<slug>/`), so relative links use `../` not `../../`.

- [ ] **Step 1: Verify the file doesn't exist yet**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && test -f bang-gia/index.html && echo "EXISTS" || echo "MISSING"
```
Expected: `MISSING`.

- [ ] **Step 2: Create the directory and file**

Create `v3/bang-gia/index.html` with this exact content:

```html
<!doctype html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Bảng Giá Lưu Trú & Dịch Vụ | Hiền Lê Garden</title>
  <meta name="description" content="Bảng giá minh bạch tại Hiền Lê Garden: lưu trú theo đêm, thuê phòng theo giờ, F&B và hoạt động trải nghiệm, gói sự kiện & team building.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400&family=Inter:wght@300;400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg-primary: #0D1F14;
      --bg-secondary: #122019;
      --bg-card: #162A1C;
      --text-primary: #F5EFE4;
      --text-secondary: rgba(245,239,228,0.7);
      --text-muted: rgba(245,239,228,0.45);
      --accent-gold: #B4904A;
      --border-subtle: rgba(245,239,228,0.08);
      --border-gold: rgba(180,144,74,0.35);
      --font-serif: 'Cormorant Garamond', serif;
      --font-sans: 'Inter', sans-serif;
    }
    html { scroll-behavior: smooth; }
    body { background: var(--bg-primary); color: var(--text-primary); font-family: var(--font-sans); font-size: 16px; line-height: 1.75; }

    .sub-nav {
      position: sticky; top: 0; z-index: 100;
      background: rgba(13,31,20,0.95); backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border-subtle);
      padding: 0 2rem; display: flex; align-items: center; justify-content: space-between; height: 60px;
    }
    .sub-nav-logo { font-family: var(--font-serif); font-size: 1.1rem; color: var(--text-primary); text-decoration: none; }
    .sub-nav-logo span { font-size: 0.65rem; color: var(--accent-gold); letter-spacing: 0.12em; text-transform: uppercase; display: block; }
    .sub-nav-back { font-size: 0.82rem; color: var(--text-muted); text-decoration: none; display: flex; align-items: center; gap: 0.4rem; transition: color 0.2s; }
    .sub-nav-back:hover { color: var(--accent-gold); }

    .page-hero {
      position: relative; min-height: 36vh;
      display: flex; align-items: flex-end;
      padding: 4rem 2rem 3rem; overflow: hidden;
    }
    .page-hero-bg { position: absolute; inset: 0; background-image: url('../images/gallery-2.jpg'); background-size: cover; background-position: center; }
    .page-hero-overlay { position: absolute; inset: 0; background: linear-gradient(to bottom, rgba(13,31,20,0.4) 0%, rgba(13,31,20,0.88) 100%); }
    .page-hero-content { position: relative; z-index: 1; max-width: 720px; }
    .page-label { font-size: 0.72rem; letter-spacing: 0.2em; text-transform: uppercase; color: var(--accent-gold); margin-bottom: 1rem; display: block; }
    .page-hero h1 { font-family: var(--font-serif); font-size: clamp(1.8rem, 4.5vw, 2.8rem); font-weight: 300; line-height: 1.25; }
    .page-hero .sub { font-size: 0.9rem; color: var(--text-secondary); margin-top: 0.75rem; }

    .content-wrap { max-width: 900px; margin: 0 auto; padding: 3rem 2rem 5rem; }

    .breadcrumb { font-size: 0.78rem; color: var(--text-muted); margin-bottom: 2rem; }
    .breadcrumb a { color: var(--accent-gold); text-decoration: none; }
    .breadcrumb a:hover { text-decoration: underline; }

    .pricing-tabs {
      display: flex;
      gap: 0;
      border: 1px solid var(--border-gold);
      border-radius: 4px;
      overflow: hidden;
      margin-bottom: 2.5rem;
      max-width: 600px;
      margin-left: auto;
      margin-right: auto;
    }
    .pricing-tab {
      flex: 1;
      padding: 0.875rem 1rem;
      font-size: 0.72rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      text-align: center;
      color: var(--text-muted);
      background: transparent;
      cursor: pointer;
      transition: all 0.2s ease;
      border: none;
      border-right: 1px solid var(--border-gold);
      font-family: var(--font-sans);
    }
    .pricing-tab:last-child { border-right: none; }
    .pricing-tab.active { background: var(--accent-gold); color: var(--bg-primary); font-weight: 600; }
    .pricing-tab:not(.active):hover { background: rgba(180,144,74,0.1); color: var(--accent-gold); }
    .pricing-panel { display: none; }
    .pricing-panel.active { display: block; animation: fadePanel 0.3s ease; }
    @keyframes fadePanel { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .pricing-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .pricing-table th {
      text-align: left; padding: 0.875rem 1rem; font-size: 0.65rem; font-weight: 500;
      letter-spacing: 0.12em; text-transform: uppercase; color: var(--accent-gold);
      border-bottom: 1px solid var(--border-gold); background: var(--bg-card);
    }
    .pricing-table td { padding: 1rem; border-bottom: 1px solid var(--border-subtle); color: var(--text-primary); vertical-align: top; }
    .pricing-table tr:last-child td { border-bottom: none; }
    .pricing-table tr:hover td { background: var(--bg-secondary); }
    .pricing-table .price { color: var(--accent-gold); font-family: var(--font-serif); font-size: 1.05rem; font-weight: 600; white-space: nowrap; }
    .pricing-table .note { font-size: 0.75rem; color: var(--text-muted); }
    .pricing-table .capacity { font-size: 0.78rem; color: var(--text-muted); white-space: nowrap; }
    .pricing-divider { margin: 2rem 0 1rem; display: flex; align-items: center; gap: 1rem; }
    .pricing-divider span { font-size: 0.65rem; letter-spacing: 0.15em; text-transform: uppercase; color: var(--accent-gold); white-space: nowrap; }
    .pricing-divider::before, .pricing-divider::after { content: ''; flex: 1; height: 1px; background: var(--border-gold); }
    .pricing-cta { margin-top: 3rem; text-align: center; padding: 2rem; border: 1px solid var(--border-gold); border-radius: 10px; background: var(--bg-card); }
    .pricing-cta p { color: var(--text-muted); font-size: 0.875rem; margin-bottom: 1.25rem; }
    .pricing-cta .hotline { font-family: var(--font-serif); font-size: 1.8rem; font-style: italic; color: var(--accent-gold); display: block; margin-bottom: 1.25rem; }

    .btn-gold { display: inline-block; background: var(--accent-gold); color: #0D1F14; padding: 0.75rem 1.75rem; border-radius: 6px; text-decoration: none; font-size: 0.85rem; font-weight: 500; transition: opacity 0.2s; border: none; cursor: pointer; }
    .btn-gold:hover { opacity: 0.88; }
    .btn-outline { display: inline-block; border: 1px solid var(--accent-gold); color: var(--accent-gold); padding: 0.75rem 1.75rem; border-radius: 6px; text-decoration: none; font-size: 0.85rem; margin-left: 0.75rem; transition: background 0.2s; }
    .btn-outline:hover { background: rgba(180,144,74,0.1); }

    @media (max-width: 640px) {
      .pricing-tabs { flex-direction: column; max-width: 100%; }
      .pricing-tab { border-right: none; border-bottom: 1px solid var(--border-gold); }
      .pricing-tab:last-child { border-bottom: none; }
      .pricing-panel { overflow-x: auto; -webkit-overflow-scrolling: touch; }
      .pricing-table { min-width: 480px; font-size: 0.82rem; }
      .pricing-table th, .pricing-table td { padding: 0.75rem 0.875rem; }
      .pricing-cta { padding: 1.5rem 1rem; }
      .pricing-cta .hotline { font-size: 1.5rem; }
      .btn-outline { margin-left: 0; margin-top: 0.5rem; display: block; }
    }

    .sub-footer { background: #060f09; border-top: 1px solid var(--border-subtle); padding: 2rem; text-align: center; }
    .sub-footer p { font-size: 0.8rem; color: var(--text-muted); }
    .sub-footer a { color: var(--accent-gold); text-decoration: none; }
  </style>
</head>
<body>

  <nav class="sub-nav">
    <a href="../" class="sub-nav-logo">
      Hiền Lê Garden
      <span>Bảng Giá</span>
    </a>
    <a href="../" class="sub-nav-back">← Trang chủ</a>
  </nav>

  <section class="page-hero">
    <div class="page-hero-bg"></div>
    <div class="page-hero-overlay"></div>
    <div class="page-hero-content">
      <span class="page-label">Bảng Giá · Pricing</span>
      <h1>Minh Bạch, Hợp Lý</h1>
      <p class="sub">Lưu trú, F&B & hoạt động, sự kiện & team building — một mức giá rõ ràng cho mọi trải nghiệm tại Hiền Lê Garden</p>
    </div>
  </section>

  <div class="content-wrap">

    <div class="breadcrumb">
      <a href="../">Trang chủ</a> / Bảng giá
    </div>

    <div class="pricing-tabs" role="tablist">
      <button class="pricing-tab active" data-tab="overnight" role="tab" aria-selected="true">Lưu Trú</button>
      <button class="pricing-tab" data-tab="activities" role="tab" aria-selected="false">F&B & Hoạt Động</button>
      <button class="pricing-tab" data-tab="events" role="tab" aria-selected="false">Sự Kiện &amp; Team Building</button>
    </div>

    <div class="pricing-panel active" id="tab-overnight">
      <div class="pricing-divider"><span>Lưu Trú Theo Đêm · Overnight Stay</span></div>
      <table class="pricing-table">
        <thead>
          <tr><th>Loại Phòng</th><th>Đơn Giá</th><th>Sức Chứa</th><th>Ghi Chú</th></tr>
        </thead>
        <tbody>
          <tr><td>Triangle House (Tiêu Chuẩn)</td><td><span class="price">300.000 đ</span></td><td class="capacity">2–3 người</td><td class="note">View vườn, giường đôi</td></tr>
          <tr><td>Circle House — Superior</td><td><span class="price">600.000 đ</span></td><td class="capacity">2–4 người</td><td class="note">View hồ, tiện nghi cao cấp hơn</td></tr>
          <tr><td>E Đê Cozy — Deluxe</td><td><span class="price">700.000 đ</span></td><td class="capacity">2–4 người</td><td class="note">Bao gồm bữa sáng</td></tr>
          <tr><td>VIP House — Premium Garden View</td><td><span class="price">900.000 đ</span></td><td class="capacity">3–5 người</td><td class="note">Sân hiên riêng, view tốt nhất</td></tr>
          <tr><td>Bungalow Gia Đình</td><td><span class="price">1.200.000 đ</span></td><td class="capacity">4–6 người</td><td class="note">Phòng rộng, full amenities</td></tr>
          <tr><td>Phòng Tập Thể</td><td><span class="price">150.000 đ</span></td><td class="capacity">10–20 người</td><td class="note">Tính theo đầu người, giường tầng</td></tr>
        </tbody>
      </table>

      <div class="pricing-divider"><span>Thuê Theo Giờ · Hourly Rental</span></div>
      <table class="pricing-table">
        <thead>
          <tr><th>Gói</th><th>Đơn Giá</th><th>Thời Gian</th><th>Ghi Chú</th></tr>
        </thead>
        <tbody>
          <tr><td>Giờ Đầu Tiên</td><td><span class="price">130.000 đ</span></td><td class="capacity">1 giờ</td><td class="note">Áp dụng toàn bộ loại phòng</td></tr>
          <tr><td>Combo 2 Giờ</td><td><span class="price">200.000 đ</span></td><td class="capacity">2 giờ</td><td class="note">Tiết kiệm hơn giờ lẻ</td></tr>
          <tr><td>Giờ Phát Sinh Thêm</td><td><span class="price">60.000 đ</span></td><td class="capacity">/ giờ thêm</td><td class="note">Sau combo 2H</td></tr>
        </tbody>
      </table>
    </div>

    <div class="pricing-panel" id="tab-activities">
      <div class="pricing-divider"><span>F&B & Hoạt Động Trải Nghiệm</span></div>
      <table class="pricing-table">
        <thead>
          <tr><th>Dịch Vụ</th><th>Đơn Giá</th><th>Đơn Vị</th><th>Ghi Chú</th></tr>
        </thead>
        <tbody>
          <tr><td>Cà phê & Nước uống</td><td><span class="price">30.000–80.000 đ</span></td><td class="capacity">/ phần</td><td class="note">Quán cà phê tại chỗ</td></tr>
          <tr><td>Ăn uống theo yêu cầu</td><td><span class="price">120.000–300.000 đ</span></td><td class="capacity">/ người / bữa</td><td class="note">Đặt trước 24h</td></tr>
          <tr><td>Đốt lửa trại (Campfire)</td><td><span class="price">500.000–1.000.000 đ</span></td><td class="capacity">/ buổi nhóm</td><td class="note">Bao gồm củi, setup, 10–50 người</td></tr>
          <tr><td>Hái trái cây tại vườn</td><td><span class="price">50.000–100.000 đ</span></td><td class="capacity">/ người</td><td class="note">Theo mùa</td></tr>
          <tr><td>Chụp ảnh / Check-in</td><td><span class="price">200.000–500.000 đ</span></td><td class="capacity">/ buổi</td><td class="note">Sử dụng cảnh quan nông trại</td></tr>
          <tr><td>Cắm trại qua đêm</td><td><span class="price">200.000–400.000 đ</span></td><td class="capacity">/ đêm / người</td><td class="note">Lều tự mang hoặc thuê</td></tr>
          <tr><td>Nông nghiệp trải nghiệm</td><td><span class="price">100.000–200.000 đ</span></td><td class="capacity">/ người</td><td class="note">Trồng rau, chăm sóc cây</td></tr>
          <tr><td>Khu vui chơi trẻ em</td><td><span class="price">Miễn phí</span></td><td class="capacity">—</td><td class="note">Tiện ích kèm theo</td></tr>
        </tbody>
      </table>
    </div>

    <div class="pricing-panel" id="tab-events">
      <div class="pricing-divider"><span>Team Building & Sự Kiện Doanh Nghiệp</span></div>
      <table class="pricing-table">
        <thead>
          <tr><th>Gói Sự Kiện</th><th>Đơn Giá</th><th>Số Người</th><th>Ghi Chú</th></tr>
        </thead>
        <tbody>
          <tr><td>Team Building / Sự kiện nhỏ</td><td><span class="price">3.000.000–5.000.000 đ</span></td><td class="capacity">20–50 người</td><td class="note">Cần đặt trước, tùy chỉnh theo yêu cầu</td></tr>
          <tr><td>Sự kiện doanh nghiệp lớn</td><td><span class="price">5.000.000–10.000.000 đ</span></td><td class="capacity">50–100 người</td><td class="note">Setup đầy đủ, tùy chỉnh theo công ty</td></tr>
          <tr><td>Bán nông sản & sản phẩm</td><td><span class="price">Theo giá thị trường</span></td><td class="capacity">—</td><td class="note">Cà phê, rau củ, trái cây tươi</td></tr>
        </tbody>
      </table>
      <div style="margin-top:1.5rem; padding:1.25rem; background:var(--bg-card); border-radius:10px; border-left:3px solid var(--accent-gold);">
        <p style="font-size:0.82rem; color:var(--text-muted); line-height:1.7;">
          ✦ Giá sự kiện chưa bao gồm ăn uống và trang trí. Vui lòng liên hệ để được tư vấn gói phù hợp nhất cho đoàn của bạn.<br>
          ✦ Event pricing excludes catering and decoration. Contact us for a custom quote.
        </p>
      </div>
    </div>

    <div class="pricing-cta">
      <p>Đặt phòng, hỏi giá, và nhận ưu đãi — Book now or inquire about packages</p>
      <a href="tel:0968987311" class="hotline">0968 987 311</a>
      <div style="display:flex; gap:1rem; justify-content:center; flex-wrap:wrap;">
        <a href="tel:0968987311" class="btn-gold">📞 Gọi Ngay</a>
        <a href="https://www.facebook.com/p/Hi%E1%BB%81n-L%C3%AA-Garden-61556329706262/" target="_blank" rel="noopener noreferrer" class="btn-outline">Facebook</a>
      </div>
    </div>

  </div>

  <footer class="sub-footer">
    <p>📍 Tổ 7 Bờ Đập, Nam Gia Nghĩa, Lâm Đồng &nbsp;|&nbsp; 📞 <a href="tel:0968987311">0968 987 311</a> &nbsp;|&nbsp; <a href="../">← Trang chủ</a></p>
    <p style="margin-top:0.5rem;">© 2026 Hiền Lê Garden. Farmstay bên hồ gần trung tâm Gia Nghĩa.</p>
  </footer>

  <script>
    document.querySelectorAll('.pricing-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const target = tab.dataset.tab;
        document.querySelectorAll('.pricing-tab').forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        document.querySelectorAll('.pricing-panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        document.getElementById('tab-' + target).classList.add('active');
      });
    });
  </script>

</body>
</html>
```

Note the two prices deliberately differ from `v1/index.html`'s stale copy: "Giờ Đầu Tiên" is **130.000 đ** (not 120.000) and "Giờ Phát Sinh Thêm" is **60.000 đ** (not 50.000) — matching the correction already applied in the root `index.html`, per the user's decision.

- [ ] **Step 3: Verify the file exists and the tab JS is wired up**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && test -f bang-gia/index.html && echo "OK exists"
grep -c 'data-tab=' bang-gia/index.html
grep -c '130.000 đ' bang-gia/index.html
grep -c '120.000 đ' bang-gia/index.html
```
Expected: `OK exists`, `3` (three tab buttons), `1` (the corrected hourly price), `0` (the stale price must NOT be present).

- [ ] **Step 4: Manually open the page and click through both tabs**

Run (macOS):
```bash
open "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3/bang-gia/index.html"
```
Confirm in the browser: page loads with dark theme, hero image renders, all 3 tabs switch panels on click, "← Trang chủ" link goes to `v3/index.html`, hotline/Facebook buttons have correct hrefs.

- [ ] **Step 5: Commit**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && git add bang-gia/index.html && git commit -m "feat(V3): add Bảng Giá page with V1 pricing content (corrected hourly rates)"
```

---

### Task 7: Add "Bảng Giá" to the main navbar

**Files:**
- Modify: `v3/index.html`

**Interfaces:** Depends on Task 6 (`bang-gia/index.html` must exist so the new link isn't dead in the final pushed state).

- [ ] **Step 1: Verify current state**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'Bảng Giá' index.html
```
Expected: `0`.

- [ ] **Step 2: Add the desktop nav link**

Find:
```html
    <ul class="nav-links">
      <li><a href="#about">Giới Thiệu</a></li>
      <li><a href="#rooms">Phòng</a></li>
      <li><a href="#gallery">Gallery</a></li>
```

Replace with:
```html
    <ul class="nav-links">
      <li><a href="#about">Giới Thiệu</a></li>
      <li><a href="#rooms">Phòng</a></li>
      <li><a href="bang-gia/">Bảng Giá</a></li>
      <li><a href="#gallery">Gallery</a></li>
```

(This assumes Task 1 already removed the `<li><a href="#amenities">Tiện Ích</a></li>` line that used to sit between `#rooms` and `#gallery`.)

- [ ] **Step 3: Add the mobile nav link**

Find:
```html
    <a href="#about">Giới Thiệu</a>
    <a href="#rooms">Phòng</a>
    <a href="#gallery">Gallery</a>
```

Replace with:
```html
    <a href="#about">Giới Thiệu</a>
    <a href="#rooms">Phòng</a>
    <a href="bang-gia/">Bảng Giá</a>
    <a href="#gallery">Gallery</a>
```

- [ ] **Step 4: Verify**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -c 'Bảng Giá' index.html
```
Expected: `2` (desktop + mobile).

- [ ] **Step 5: Commit**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && git add index.html && git commit -m "feat(V3): add Bảng Giá link to main navbar (desktop + mobile)"
```

---

### Task 8: Final verification and push

**Files:** None (verification only).

- [ ] **Step 1: Confirm no dangling references to removed features**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -rn '#amenities\|checkAvailability\|availCheckBtn\|availStatus\|avail-status' index.html bang-gia/index.html
```
Expected: no output (empty).

- [ ] **Step 2: Confirm the target homepage section order**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && grep -n '<section' index.html
```
Expected order of `id=` values: `hero`, `booking`, `direct-booking-offer`, `about`, `rooms`, `timeline`, `gallery`, `drone-video`, `reviews`, `events` (with `style="display:none"`), `ota` (with `style="display:none"`), `blog`, `faq`, `map`, `closing-cta`. No `amenities`.

- [ ] **Step 3: Open the homepage and the new pricing page in a browser and click through**

```bash
open "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3/index.html"
```
Manually confirm: navbar shows "Bảng Giá" (no "Tiện Ích"), clicking it opens `bang-gia/index.html`; booking form submit opens Facebook (no fake "checking availability" message appears); Reviews section shows the 3 platform cards with honest copy and working outbound links; no Amenities/"Vườn Hoa Cỏ May" section appears anywhere; Events section is not visible.

- [ ] **Step 4: Push all commits**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && git push
```

- [ ] **Step 5: Confirm remote is up to date**

```bash
cd "/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/v3" && git status
```
Expected: `Your branch is up to date with 'origin/main'.` and `nothing to commit, working tree clean`.

---

## Self-Review

1. **Spec coverage:** Every "Decisions (confirmed with user)" item in the design spec maps to a task — Amenities removal → Task 1; booking form swap → Task 2; rooms copy sync → Task 3; events hide → Task 4; reviews redesign → Task 5; new pricing page (with the 130k/60k correction decided after spec was written) → Task 6; navbar update → Task 7; direct-booking-offer banner is explicitly left untouched (no task needed). Final homepage section order is verified in Task 8.
2. **Placeholder scan:** No TBDs; every step has literal find/replace content or a full file body.
3. **Type/name consistency:** `handleBooking()` in Task 2 matches the function name used nowhere else; `openBookingModal()`/`submitBooking()` referenced as untouched are the same names used in the existing modal code. The new page's CSS variable names (`--bg-card`, `--border-gold`, etc.) are used consistently within Task 6's single file — no cross-file dependency to mismatch.
