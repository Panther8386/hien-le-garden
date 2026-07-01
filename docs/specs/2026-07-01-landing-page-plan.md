# Hiền Lê Garden Landing Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a single `index.html` premium dark-theme bilingual landing page for Hiền Lê Garden Farmstay that looks like a $10,000 agency website.

**Architecture:** Single self-contained `index.html` with all CSS in a `<style>` block and all JS in a `<script>` block at the bottom. No build step, no framework, no external JS libraries. Google Fonts loaded via CDN link tag.

**Tech Stack:** HTML5 · CSS3 (custom properties, grid, flexbox, animations) · Vanilla JavaScript (IntersectionObserver, classList, scroll events)

## Global Constraints

- Output file: `/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/index.html`
- Hotline (single, everywhere): **0968 987 311**
- Language: Vietnamese primary, English secondary (bilingual)
- Color palette: `--bg-primary: #0D1F13` · `--accent-gold: #C9A84C` · `--accent-emerald: #10B981` · `--text-primary: #F5F5EF`
- Fonts: Cormorant Garamond (headings, italic) + Inter (body) — Google Fonts CDN
- No jQuery, no Bootstrap, no external JS
- All images: Unsplash placeholder URLs (farmstay/nature/lake themed) — user replaces with real photos
- Responsive: mobile-first, breakpoints at 768px and 1280px
- All animations: only `transform` and `opacity` (GPU-accelerated, no layout thrash)

---

## File Structure

```
/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/
└── index.html   ← single output file, all CSS/JS embedded
```

Build sections in order, each as an additive block to the same file.

---

### Task 1: HTML Boilerplate + Design System

**Files:**
- Create: `/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/index.html`

**Interfaces:**
- Produces: Full HTML shell with CSS custom properties and base resets that all later tasks depend on

- [ ] **Step 1: Create the HTML file**

Create `/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/index.html` with this exact content:

```html
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hiền Lê Garden — Farmstay Buôn Ma Thuột</title>
  <meta name="description" content="Hiền Lê Garden Farmstay — Check-in thiên nhiên, view hồ cực chill. Bình yên giữa lòng thành phố Buôn Ma Thuột.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,600;1,300;1,400;1,600&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet">
  <style>
    /* ============================================
       DESIGN SYSTEM — CSS CUSTOM PROPERTIES
    ============================================ */
    :root {
      --bg-primary: #0D1F13;
      --bg-secondary: #111D15;
      --bg-surface: #172A1C;
      --bg-card: #1A2E1F;
      --accent-gold: #C9A84C;
      --accent-gold-lt: #E8C96A;
      --accent-emerald: #10B981;
      --accent-emerald-dk: #059669;
      --text-primary: #F5F5EF;
      --text-muted: #9CA3AF;
      --text-dim: #6B7280;
      --border-gold: rgba(201,168,76,0.3);
      --border-subtle: rgba(255,255,255,0.07);
      --overlay: rgba(13,31,19,0.55);

      --font-serif: 'Cormorant Garamond', Georgia, serif;
      --font-sans: 'Inter', system-ui, sans-serif;

      --spacing-xs: 0.5rem;
      --spacing-sm: 1rem;
      --spacing-md: 2rem;
      --spacing-lg: 4rem;
      --spacing-xl: 8rem;

      --radius-sm: 4px;
      --radius-md: 8px;
      --radius-lg: 16px;

      --transition: 0.3s ease;
      --transition-slow: 0.6s ease;
    }

    /* ============================================
       BASE RESET
    ============================================ */
    *, *::before, *::after {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html {
      scroll-behavior: smooth;
      font-size: 16px;
    }

    body {
      background-color: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-sans);
      font-weight: 300;
      line-height: 1.6;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }

    img {
      display: block;
      max-width: 100%;
      height: auto;
    }

    a {
      color: inherit;
      text-decoration: none;
    }

    button {
      font-family: var(--font-sans);
      cursor: pointer;
      border: none;
      background: none;
    }

    /* ============================================
       TYPOGRAPHY UTILITIES
    ============================================ */
    .serif { font-family: var(--font-serif); }
    .gold { color: var(--accent-gold); }
    .emerald { color: var(--accent-emerald); }
    .muted { color: var(--text-muted); }

    .label {
      font-family: var(--font-sans);
      font-size: 0.7rem;
      font-weight: 500;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--accent-gold);
    }

    /* ============================================
       SCROLL ANIMATION BASE
    ============================================ */
    .fade-in {
      opacity: 0;
      transform: translateY(24px);
      transition: opacity 0.7s ease, transform 0.7s ease;
    }
    .fade-in.visible {
      opacity: 1;
      transform: translateY(0);
    }

    /* ============================================
       SECTION LAYOUT
    ============================================ */
    .section {
      padding: var(--spacing-xl) var(--spacing-md);
    }

    .container {
      max-width: 1280px;
      margin: 0 auto;
      padding: 0 var(--spacing-md);
    }

    .section-header {
      text-align: center;
      margin-bottom: var(--spacing-lg);
    }

    .section-header h2 {
      font-family: var(--font-serif);
      font-size: clamp(2rem, 5vw, 3.5rem);
      font-weight: 300;
      font-style: italic;
      color: var(--text-primary);
      line-height: 1.2;
      margin-top: var(--spacing-xs);
    }

    /* ============================================
       BUTTON SYSTEM
    ============================================ */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.875rem 2rem;
      font-family: var(--font-sans);
      font-size: 0.8rem;
      font-weight: 500;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      border-radius: var(--radius-sm);
      transition: all var(--transition);
    }

    .btn-gold {
      background: var(--accent-gold);
      color: var(--bg-primary);
    }
    .btn-gold:hover {
      background: var(--accent-gold-lt);
      transform: translateY(-2px);
      box-shadow: 0 8px 24px rgba(201,168,76,0.3);
    }

    .btn-outline {
      background: transparent;
      color: var(--text-primary);
      border: 1px solid rgba(255,255,255,0.3);
    }
    .btn-outline:hover {
      border-color: var(--accent-gold);
      color: var(--accent-gold);
      transform: translateY(-2px);
    }

    .btn-emerald {
      background: transparent;
      color: var(--accent-emerald);
      border: 1px solid var(--accent-emerald);
    }
    .btn-emerald:hover {
      background: var(--accent-emerald);
      color: var(--bg-primary);
      transform: translateY(-2px);
    }
  </style>
</head>
<body>

  <!-- SECTIONS WILL BE ADDED HERE IN SUBSEQUENT TASKS -->

  <script>
    // JS WILL BE ADDED HERE IN SUBSEQUENT TASKS
  </script>
</body>
</html>
```

- [ ] **Step 2: Verify in browser**

Open `/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/index.html` in browser.
Expected: Dark green page (`#0D1F13`), no errors in browser console, Google Fonts loaded (check Network tab).

---

### Task 2: Sticky Navigation

**Files:**
- Modify: `index.html` — add nav HTML before `<!-- SECTIONS WILL BE ADDED HERE -->` and nav CSS inside `<style>`, nav JS inside `<script>`

**Interfaces:**
- Consumes: CSS variables from Task 1
- Produces: `<nav id="navbar">` element that all anchor links reference

- [ ] **Step 1: Add nav CSS** inside the `<style>` block (before closing `</style>`):

```css
/* ============================================
   NAVIGATION
============================================ */
#navbar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  padding: 1.25rem var(--spacing-md);
  display: flex;
  align-items: center;
  justify-content: space-between;
  transition: background var(--transition), backdrop-filter var(--transition), padding var(--transition);
}

#navbar.scrolled {
  background: rgba(13,31,19,0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  padding: 0.875rem var(--spacing-md);
  border-bottom: 1px solid var(--border-gold);
}

.nav-logo {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 1.3rem;
  font-weight: 400;
  color: var(--accent-gold);
  letter-spacing: 0.04em;
  line-height: 1;
}

.nav-logo span {
  display: block;
  font-size: 0.55rem;
  font-style: normal;
  font-family: var(--font-sans);
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: var(--text-muted);
  margin-top: 2px;
}

.nav-links {
  display: flex;
  align-items: center;
  gap: 2.5rem;
  list-style: none;
}

.nav-links a {
  font-size: 0.75rem;
  font-weight: 400;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-muted);
  transition: color var(--transition);
  position: relative;
}

.nav-links a::after {
  content: '';
  position: absolute;
  bottom: -4px;
  left: 0;
  width: 0;
  height: 1px;
  background: var(--accent-gold);
  transition: width var(--transition);
}

.nav-links a:hover {
  color: var(--accent-gold);
}

.nav-links a:hover::after {
  width: 100%;
}

.nav-cta {
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--accent-emerald);
  border: 1px solid var(--accent-emerald);
  padding: 0.6rem 1.4rem;
  border-radius: var(--radius-sm);
  transition: all var(--transition);
}

.nav-cta:hover {
  background: var(--accent-emerald);
  color: var(--bg-primary);
}

/* Hamburger - mobile */
.nav-hamburger {
  display: none;
  flex-direction: column;
  gap: 5px;
  cursor: pointer;
  padding: 4px;
}
.nav-hamburger span {
  display: block;
  width: 24px;
  height: 1.5px;
  background: var(--text-primary);
  transition: all var(--transition);
}

/* Mobile overlay menu */
.nav-mobile-overlay {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(13,31,19,0.97);
  z-index: 999;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2rem;
}
.nav-mobile-overlay.open {
  display: flex;
}
.nav-mobile-overlay a {
  font-family: var(--font-serif);
  font-size: 2rem;
  font-style: italic;
  color: var(--text-primary);
  transition: color var(--transition);
}
.nav-mobile-overlay a:hover { color: var(--accent-gold); }
.nav-mobile-close {
  position: absolute;
  top: 1.5rem;
  right: 1.5rem;
  font-size: 1.5rem;
  color: var(--text-muted);
  cursor: pointer;
  background: none;
  border: none;
  color: var(--text-primary);
}

@media (max-width: 768px) {
  .nav-links { display: none; }
  .nav-cta-desktop { display: none; }
  .nav-hamburger { display: flex; }
}
```

- [ ] **Step 2: Add nav HTML** inside `<body>`, before `<!-- SECTIONS WILL BE ADDED HERE -->`:

```html
<nav id="navbar">
  <a href="#home" class="nav-logo">
    Hiền Lê Garden
    <span>Farmstay · Buôn Ma Thuột</span>
  </a>

  <ul class="nav-links">
    <li><a href="#overview">Tổng Quan</a></li>
    <li><a href="#rooms">Phòng</a></li>
    <li><a href="#experience">Trải Nghiệm</a></li>
    <li><a href="#pricing">Bảng Giá</a></li>
    <li><a href="#contact">Liên Hệ</a></li>
  </ul>

  <a href="tel:0968987311" class="nav-cta nav-cta-desktop">Đặt Phòng Ngay</a>

  <button class="nav-hamburger" id="navHamburger" aria-label="Menu">
    <span></span><span></span><span></span>
  </button>
</nav>

<!-- Mobile Overlay -->
<div class="nav-mobile-overlay" id="mobileOverlay">
  <button class="nav-mobile-close" id="mobileClose">✕</button>
  <a href="#overview" class="mobile-nav-link">Tổng Quan</a>
  <a href="#rooms" class="mobile-nav-link">Phòng</a>
  <a href="#experience" class="mobile-nav-link">Trải Nghiệm</a>
  <a href="#pricing" class="mobile-nav-link">Bảng Giá</a>
  <a href="#contact" class="mobile-nav-link">Liên Hệ</a>
  <a href="tel:0968987311" class="btn btn-emerald">📞 0968 987 311</a>
</div>
```

- [ ] **Step 3: Add nav JS** inside `<script>` block:

```js
// Nav scroll effect
const navbar = document.getElementById('navbar');
window.addEventListener('scroll', () => {
  navbar.classList.toggle('scrolled', window.scrollY > 80);
});

// Mobile menu
const hamburger = document.getElementById('navHamburger');
const mobileOverlay = document.getElementById('mobileOverlay');
const mobileClose = document.getElementById('mobileClose');

hamburger.addEventListener('click', () => mobileOverlay.classList.add('open'));
mobileClose.addEventListener('click', () => mobileOverlay.classList.remove('open'));
document.querySelectorAll('.mobile-nav-link').forEach(link => {
  link.addEventListener('click', () => mobileOverlay.classList.remove('open'));
});
```

- [ ] **Step 4: Verify**

Open in browser. Expected:
- Nav visible at top, transparent background
- After scrolling 80px: blurred dark glass background + gold border appears
- On mobile (<768px): hamburger shows, links hidden; tap hamburger → overlay opens

---

### Task 3: Hero Section

**Files:**
- Modify: `index.html` — hero HTML + CSS

**Interfaces:**
- Consumes: nav from Task 2 (hero starts below nav, `id="home"`)
- Produces: `<section id="home">` with staggered animation classes JS activates

- [ ] **Step 1: Add hero CSS** inside `<style>` block:

```css
/* ============================================
   HERO SECTION
============================================ */
#home {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.hero-bg {
  position: absolute;
  inset: 0;
  background-image: url('https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=1920&q=80');
  /* REPLACE: aerial lake view photo from Facebook */
  background-size: cover;
  background-position: center 40%;
  background-attachment: fixed;
  transform: scale(1.05);
  transition: transform 8s ease;
}

.hero-bg.loaded { transform: scale(1); }

.hero-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    rgba(13,31,19,0.3) 0%,
    rgba(13,31,19,0.5) 50%,
    rgba(13,31,19,0.85) 100%
  );
}

.hero-content {
  position: relative;
  z-index: 2;
  text-align: center;
  padding: 0 var(--spacing-md);
  max-width: 900px;
}

.hero-eyebrow {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--accent-gold);
  margin-bottom: 1.5rem;
  opacity: 0;
  transform: translateY(20px);
  animation: heroFadeUp 0.8s ease 0.3s forwards;
}

.hero-title {
  font-family: var(--font-serif);
  font-weight: 300;
  font-style: italic;
  line-height: 1.05;
  margin-bottom: 1.5rem;
}

.hero-title-line {
  display: block;
  font-size: clamp(3.5rem, 10vw, 7rem);
  color: var(--text-primary);
  opacity: 0;
  transform: translateY(30px);
}

.hero-title-line:nth-child(1) { animation: heroFadeUp 0.9s ease 0.5s forwards; }
.hero-title-line:nth-child(2) { animation: heroFadeUp 0.9s ease 0.7s forwards; }
.hero-title-line:nth-child(3) { animation: heroFadeUp 0.9s ease 0.9s forwards; }

.hero-title-line.gold-line { color: var(--accent-gold); }

.hero-sub {
  font-size: 1.1rem;
  font-weight: 300;
  color: rgba(245,245,239,0.75);
  font-style: italic;
  font-family: var(--font-serif);
  letter-spacing: 0.03em;
  margin-bottom: 2.5rem;
  opacity: 0;
  animation: heroFadeUp 0.9s ease 1.1s forwards;
}

.hero-actions {
  display: flex;
  gap: 1rem;
  justify-content: center;
  flex-wrap: wrap;
  opacity: 0;
  animation: heroFadeUp 0.9s ease 1.3s forwards;
}

.hero-scroll {
  position: absolute;
  bottom: 2rem;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  opacity: 0;
  animation: heroFadeUp 1s ease 1.6s forwards;
}

.hero-scroll span {
  font-size: 0.6rem;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.scroll-line {
  width: 1px;
  height: 48px;
  background: linear-gradient(to bottom, var(--accent-gold), transparent);
  animation: scrollPulse 2s ease-in-out infinite;
}

@keyframes heroFadeUp {
  to { opacity: 1; transform: translateY(0); }
}

@keyframes scrollPulse {
  0%, 100% { opacity: 0.3; transform: scaleY(1); }
  50% { opacity: 1; transform: scaleY(1.2); }
}
```

- [ ] **Step 2: Add hero HTML** inside `<body>` after the nav mobile overlay:

```html
<section id="home">
  <div class="hero-bg" id="heroBg"></div>
  <div class="hero-overlay"></div>
  <div class="hero-content">
    <span class="hero-eyebrow">Farmstay · Buôn Ma Thuột · Đắk Lắk</span>
    <h1 class="hero-title">
      <span class="hero-title-line">Bình Yên</span>
      <span class="hero-title-line gold-line">Giữa Lòng</span>
      <span class="hero-title-line">Thành Phố</span>
    </h1>
    <p class="hero-sub">Check-in thiên nhiên — View hồ cực chill · Nature Check-in — Stunning Lake Views</p>
    <div class="hero-actions">
      <a href="#rooms" class="btn btn-gold">Khám Phá Phòng</a>
      <a href="#pricing" class="btn btn-outline">Xem Bảng Giá</a>
    </div>
  </div>
  <div class="hero-scroll">
    <div class="scroll-line"></div>
    <span>Khám phá</span>
  </div>
</section>
```

- [ ] **Step 3: Add hero JS** inside `<script>` block:

```js
// Hero bg scale on load
window.addEventListener('load', () => {
  document.getElementById('heroBg').classList.add('loaded');
});
```

- [ ] **Step 4: Verify**

Open in browser. Expected:
- Fullscreen dark hero with nature photo background
- `BÌNH YÊN / GIỮA LÒNG / THÀNH PHỐ` fades in staggered over 1.3s
- Scroll indicator pulses at bottom
- "Giữa Lòng" line is gold

---

### Task 4: Stats Bar

**Files:**
- Modify: `index.html` — stats HTML + CSS + counter JS

**Interfaces:**
- Consumes: `.fade-in` / `.visible` classes from Task 1 base styles
- Produces: `<section id="overview">` scroll anchor for nav

- [ ] **Step 1: Add stats CSS** inside `<style>`:

```css
/* ============================================
   STATS BAR
============================================ */
#overview {
  background: var(--bg-secondary);
  border-top: 1px solid var(--border-gold);
  border-bottom: 1px solid var(--border-gold);
  padding: 3.5rem var(--spacing-md);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0;
  max-width: 1000px;
  margin: 0 auto;
}

.stat-item {
  text-align: center;
  padding: 1rem 2rem;
  position: relative;
}

.stat-item:not(:last-child)::after {
  content: '';
  position: absolute;
  right: 0;
  top: 20%;
  height: 60%;
  width: 1px;
  background: var(--border-gold);
}

.stat-number {
  font-family: var(--font-serif);
  font-size: clamp(2.5rem, 5vw, 3.5rem);
  font-weight: 300;
  color: var(--accent-gold);
  line-height: 1;
  margin-bottom: 0.5rem;
}

.stat-label-vi {
  font-size: 0.85rem;
  font-weight: 400;
  color: var(--text-primary);
  margin-bottom: 0.2rem;
}

.stat-label-en {
  font-size: 0.65rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-dim);
}

@media (max-width: 768px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .stat-item:nth-child(2)::after { display: none; }
  .stat-item:nth-child(odd):not(:last-child)::after { display: block; }
  .stat-item:nth-child(even)::after { display: none; }
}
```

- [ ] **Step 2: Add stats HTML** after `</section>` (hero end):

```html
<section id="overview">
  <div class="stats-grid">
    <div class="stat-item fade-in">
      <div class="stat-number" data-count="5">0</div>
      <div class="stat-label-vi">Kiểu Phòng Độc Đáo</div>
      <div class="stat-label-en">Unique Room Styles</div>
    </div>
    <div class="stat-item fade-in">
      <div class="stat-number" data-count="10">0</div>
      <div class="stat-label-vi">Ha Khuôn Viên</div>
      <div class="stat-label-en">Hectares of Nature</div>
    </div>
    <div class="stat-item fade-in">
      <div class="stat-number" data-count="100">0</div>
      <div class="stat-label-vi">Khách Sự Kiện</div>
      <div class="stat-label-en">Event Capacity</div>
    </div>
    <div class="stat-item fade-in">
      <div class="stat-number">∞</div>
      <div class="stat-label-vi">View Hồ Panorama</div>
      <div class="stat-label-en">Lake Panorama Views</div>
    </div>
  </div>
</section>
```

- [ ] **Step 3: Add counter + IntersectionObserver JS** inside `<script>`:

```js
// IntersectionObserver for all .fade-in elements
const fadeObserver = new IntersectionObserver((entries) => {
  entries.forEach((entry, i) => {
    if (entry.isIntersecting) {
      setTimeout(() => entry.target.classList.add('visible'), i * 80);
      fadeObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.15 });

document.querySelectorAll('.fade-in').forEach(el => fadeObserver.observe(el));

// Counter animation
function animateCounter(el) {
  const target = parseInt(el.dataset.count);
  if (!target) return;
  const duration = 1400;
  const start = performance.now();
  const update = (now) => {
    const progress = Math.min((now - start) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.floor(ease * target) + (target === 100 ? '+' : target === 5 ? '+' : 'ha');
    if (progress < 1) requestAnimationFrame(update);
    else el.textContent = target + (target === 100 ? '+' : target === 5 ? '+' : 'ha');
  };
  requestAnimationFrame(update);
}

const counterObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.querySelectorAll('[data-count]').forEach(animateCounter);
      counterObserver.unobserve(entry.target);
    }
  });
}, { threshold: 0.5 });

document.querySelectorAll('#overview').forEach(el => counterObserver.observe(el));
```

- [ ] **Step 4: Verify**

Scroll to stats bar. Expected:
- 4 stats appear side by side with gold dividers
- Numbers count up (5+, 10ha, 100+) when scrolled into view

---

### Task 5: Feature Grid

**Files:**
- Modify: `index.html` — feature grid HTML + CSS

**Interfaces:**
- Produces: `<section id="experience">` scroll anchor

- [ ] **Step 1: Add feature grid CSS** inside `<style>`:

```css
/* ============================================
   FEATURE GRID
============================================ */
#experience {
  background: var(--bg-primary);
}

.features-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: var(--border-subtle);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.feature-card {
  background: var(--bg-primary);
  padding: 2.5rem 2rem;
  transition: background var(--transition);
  position: relative;
  overflow: hidden;
}

.feature-card::before {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 2px;
  background: linear-gradient(to right, transparent, var(--accent-gold), transparent);
  transform: scaleX(0);
  transition: transform var(--transition);
}

.feature-card:hover {
  background: var(--bg-surface);
}

.feature-card:hover::before {
  transform: scaleX(1);
}

.feature-icon {
  font-size: 2rem;
  margin-bottom: 1.25rem;
  display: block;
}

.feature-title-vi {
  font-family: var(--font-serif);
  font-size: 1.25rem;
  font-weight: 400;
  color: var(--text-primary);
  margin-bottom: 0.25rem;
  line-height: 1.3;
}

.feature-title-en {
  font-size: 0.65rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent-gold);
  margin-bottom: 0.875rem;
}

.feature-desc {
  font-size: 0.875rem;
  color: var(--text-muted);
  line-height: 1.6;
}

@media (max-width: 1024px) {
  .features-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 600px) {
  .features-grid { grid-template-columns: 1fr; }
}
```

- [ ] **Step 2: Add feature grid HTML** after stats `</section>`:

```html
<section class="section" id="experience">
  <div class="container">
    <div class="section-header fade-in">
      <span class="label">Trải Nghiệm · Experience</span>
      <h2>Mọi Khoảnh Khắc Đều Đáng Nhớ</h2>
    </div>
    <div class="features-grid">
      <div class="feature-card fade-in">
        <span class="feature-icon">🏔️</span>
        <div class="feature-title-vi">View Hồ Panorama</div>
        <div class="feature-title-en">Lake Panorama View</div>
        <p class="feature-desc">Tầm nhìn rộng mở ra hồ nước xanh mát, cảnh quan thiên nhiên hùng vĩ chỉ cách thành phố vài phút.</p>
      </div>
      <div class="feature-card fade-in">
        <span class="feature-icon">🏠</span>
        <div class="feature-title-vi">Triangle House</div>
        <div class="feature-title-en">Iconic A-Frame Cabins</div>
        <p class="feature-desc">Kiến trúc mái tam giác độc đáo, không gian ấm cúng với gỗ tự nhiên, hoà mình vào cảnh quan xanh.</p>
      </div>
      <div class="feature-card fade-in">
        <span class="feature-icon">⭕</span>
        <div class="feature-title-vi">Circle House</div>
        <div class="feature-title-en">Artistic Barrel Rooms</div>
        <p class="feature-desc">Phòng hình tròn nghệ thuật độc đáo — điểm check-in ấn tượng, nội thất hiện đại trong không gian thiên nhiên.</p>
      </div>
      <div class="feature-card fade-in">
        <span class="feature-icon">🌸</span>
        <div class="feature-title-vi">Vườn Hoa Cỏ May</div>
        <div class="feature-title-en">Wildflower Garden</div>
        <p class="feature-desc">Cánh đồng hoa cỏ may rực rỡ theo mùa — khung cảnh nên thơ lý tưởng cho ảnh cưới và check-in.</p>
      </div>
      <div class="feature-card fade-in">
        <span class="feature-icon">🔥</span>
        <div class="feature-title-vi">Campfire & Glamping</div>
        <div class="feature-title-en">Campfire & Overnight Camping</div>
        <p class="feature-desc">Đốt lửa trại dưới bầu trời đêm, cắm trại qua đêm giữa thiên nhiên — trải nghiệm không thể quên.</p>
      </div>
      <div class="feature-card fade-in">
        <span class="feature-icon">☕</span>
        <div class="feature-title-vi">Cà Phê Giữa Vườn</div>
        <div class="feature-title-en">Garden Café</div>
        <p class="feature-desc">Thưởng thức cà phê Ban Mê giữa không gian xanh mát, ngắm hồ — khoảnh khắc bình yên giữa lòng thành phố.</p>
      </div>
      <div class="feature-card fade-in">
        <span class="feature-icon">👥</span>
        <div class="feature-title-vi">Team Building</div>
        <div class="feature-title-en">Corporate Events & Team Building</div>
        <p class="feature-desc">Không gian rộng rãi cho sự kiện doanh nghiệp 20–100 người, thiết kế theo yêu cầu riêng.</p>
      </div>
      <div class="feature-card fade-in">
        <span class="feature-icon">📸</span>
        <div class="feature-title-vi">Check-in Sống Ảo</div>
        <div class="feature-title-en">Photo & Check-in Spots</div>
        <p class="feature-desc">Hàng chục góc chụp ảnh đẹp — từ cổng làng đến bờ hồ, vườn hoa đến các căn phòng nghệ thuật.</p>
      </div>
      <div class="feature-card fade-in">
        <span class="feature-icon">🌱</span>
        <div class="feature-title-vi">Nông Nghiệm Trải Nghiệm</div>
        <div class="feature-title-en">Agri-Experience</div>
        <p class="feature-desc">Trồng rau, hái quả, học chăm sóc cây trái — trải nghiệm nông nghiệp thực thụ cho mọi lứa tuổi.</p>
      </div>
    </div>
  </div>
</section>
```

- [ ] **Step 3: Verify**

Scroll to feature grid. Expected:
- 3×3 grid of dark cards, separated by subtle 1px lines
- Gold underline slides in on hover per card
- Cards fade in staggered on scroll

---

### Task 6: Room Showcase

**Files:**
- Modify: `index.html` — room section HTML + CSS

**Interfaces:**
- Produces: `<section id="rooms">` scroll anchor

- [ ] **Step 1: Add room CSS** inside `<style>`:

```css
/* ============================================
   ROOM SHOWCASE
============================================ */
#rooms {
  background: var(--bg-secondary);
}

.rooms-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1.5rem;
}

.room-card {
  background: var(--bg-card);
  border-radius: var(--radius-md);
  overflow: hidden;
  border: 1px solid var(--border-subtle);
  transition: transform var(--transition), box-shadow var(--transition), border-color var(--transition);
  cursor: pointer;
}

.room-card:hover {
  transform: translateY(-8px);
  box-shadow: 0 24px 48px rgba(0,0,0,0.4);
  border-color: var(--border-gold);
}

.room-img {
  position: relative;
  height: 220px;
  overflow: hidden;
}

.room-img img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--transition-slow);
}

.room-card:hover .room-img img {
  transform: scale(1.08);
}

.room-badge {
  position: absolute;
  top: 1rem;
  left: 1rem;
  background: rgba(13,31,19,0.85);
  backdrop-filter: blur(8px);
  border: 1px solid var(--border-gold);
  color: var(--accent-gold);
  font-size: 0.6rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 0.35rem 0.75rem;
  border-radius: 2px;
}

.room-price-badge {
  position: absolute;
  bottom: 1rem;
  right: 1rem;
  background: var(--accent-gold);
  color: var(--bg-primary);
  font-family: var(--font-serif);
  font-size: 1.1rem;
  font-weight: 600;
  padding: 0.4rem 0.875rem;
  border-radius: var(--radius-sm);
}

.room-price-badge small {
  font-size: 0.6rem;
  font-family: var(--font-sans);
  font-weight: 400;
  display: block;
  text-align: right;
  margin-top: -2px;
  opacity: 0.7;
}

.room-info {
  padding: 1.5rem;
}

.room-name {
  font-family: var(--font-serif);
  font-size: 1.3rem;
  font-weight: 400;
  color: var(--text-primary);
  margin-bottom: 0.5rem;
}

.room-meta {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 0.875rem;
}

.room-meta span {
  font-size: 0.7rem;
  color: var(--text-muted);
  letter-spacing: 0.05em;
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.room-desc {
  font-size: 0.82rem;
  color: var(--text-muted);
  line-height: 1.6;
}

@media (max-width: 1024px) {
  .rooms-grid { grid-template-columns: repeat(2, 1fr); }
}

@media (max-width: 600px) {
  .rooms-grid { grid-template-columns: 1fr; }
}
```

- [ ] **Step 2: Add room HTML** after feature grid `</section>`:

```html
<section class="section" id="rooms">
  <div class="container">
    <div class="section-header fade-in">
      <span class="label">Lưu Trú · Accommodation</span>
      <h2>Chọn Không Gian Của Bạn</h2>
    </div>
    <div class="rooms-grid">

      <div class="room-card fade-in">
        <div class="room-img">
          <img src="https://images.unsplash.com/photo-1510798831971-661eb04b3739?w=600&q=80" alt="Triangle House" loading="lazy">
          <!-- REPLACE: Triangle House exterior photo -->
          <span class="room-badge">Triangle House</span>
          <div class="room-price-badge">300K<small>đ / đêm</small></div>
        </div>
        <div class="room-info">
          <div class="room-name">Triangle House</div>
          <div class="room-meta">
            <span>👥 2–3 người</span>
            <span>🌿 View vườn</span>
          </div>
          <p class="room-desc">Cabin mái tam giác độc đáo, giường đôi, không gian gỗ ấm cúng giữa thiên nhiên.</p>
        </div>
      </div>

      <div class="room-card fade-in">
        <div class="room-img">
          <img src="https://images.unsplash.com/photo-1540541338537-71cf2c455900?w=600&q=80" alt="Circle House" loading="lazy">
          <!-- REPLACE: Circle House exterior photo -->
          <span class="room-badge">Circle House</span>
          <div class="room-price-badge">600K<small>đ / đêm</small></div>
        </div>
        <div class="room-info">
          <div class="room-name">Circle House — Superior</div>
          <div class="room-meta">
            <span>👥 2–4 người</span>
            <span>🏔️ View hồ</span>
          </div>
          <p class="room-desc">Phòng hình tròn nghệ thuật, view hồ, tiện nghi cao cấp hơn. Điểm check-in ấn tượng.</p>
        </div>
      </div>

      <div class="room-card fade-in">
        <div class="room-img">
          <img src="https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=600&q=80" alt="E De Cozy House" loading="lazy">
          <!-- REPLACE: E Đê Cozy House photo -->
          <span class="room-badge">E Đê Cozy</span>
          <div class="room-price-badge">700K<small>đ / đêm</small></div>
        </div>
        <div class="room-info">
          <div class="room-name">E Đê Cozy House — Deluxe</div>
          <div class="room-meta">
            <span>👥 2–4 người</span>
            <span>🍳 Bao gồm sáng</span>
          </div>
          <p class="room-desc">Kiến trúc độc đáo phong cách Tây Nguyên, bao gồm bữa sáng, nội thất đầy đủ tiện nghi.</p>
        </div>
      </div>

      <div class="room-card fade-in">
        <div class="room-img">
          <img src="https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=600&q=80" alt="VIP House" loading="lazy">
          <!-- REPLACE: VIP House / Premium Garden View photo -->
          <span class="room-badge">VIP House</span>
          <div class="room-price-badge">900K<small>đ / đêm</small></div>
        </div>
        <div class="room-info">
          <div class="room-name">VIP House — Premium</div>
          <div class="room-meta">
            <span>👥 3–5 người</span>
            <span>🌅 Sân hiên riêng</span>
          </div>
          <p class="room-desc">View đẹp nhất khu, sân hiên riêng nhìn ra hồ và vườn hoa, tiện nghi cao cấp đầy đủ.</p>
        </div>
      </div>

      <div class="room-card fade-in">
        <div class="room-img">
          <img src="https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&q=80" alt="Bungalow Gia Dinh" loading="lazy">
          <!-- REPLACE: Bungalow / Family room photo -->
          <span class="room-badge">Bungalow</span>
          <div class="room-price-badge">1.2M<small>đ / đêm</small></div>
        </div>
        <div class="room-info">
          <div class="room-name">Bungalow Gia Đình</div>
          <div class="room-meta">
            <span>👥 4–6 người</span>
            <span>🏠 Full amenities</span>
          </div>
          <p class="room-desc">Không gian rộng rãi nhất, đầy đủ tiện nghi cao cấp, phù hợp gia đình hoặc nhóm bạn.</p>
        </div>
      </div>

      <div class="room-card fade-in">
        <div class="room-img">
          <img src="https://images.unsplash.com/photo-1537640538966-79f369143f8f?w=600&q=80" alt="Phong Tap The" loading="lazy">
          <!-- REPLACE: Dormitory / camping photo -->
          <span class="room-badge">Tập Thể</span>
          <div class="room-price-badge">150K<small>đ / người</small></div>
        </div>
        <div class="room-info">
          <div class="room-name">Phòng Tập Thể</div>
          <div class="room-meta">
            <span>👥 10–20 người</span>
            <span>🛏️ Giường tầng</span>
          </div>
          <p class="room-desc">Giường tầng, giá hợp lý theo đầu người. Lý tưởng cho nhóm bạn trẻ, lớp học, đoàn tham quan.</p>
        </div>
      </div>

    </div>
  </div>
</section>
```

- [ ] **Step 3: Verify**

Scroll to rooms section. Expected:
- 3×2 grid of room cards
- Price badge gold, bottom-right of image
- Card lifts 8px and gets gold border on hover
- Image zooms subtly on hover

---

### Task 7: Pricing Table

**Files:**
- Modify: `index.html` — pricing HTML + CSS + tab JS

**Interfaces:**
- Produces: `<section id="pricing">` scroll anchor

- [ ] **Step 1: Add pricing CSS** inside `<style>`:

```css
/* ============================================
   PRICING TABLE
============================================ */
#pricing {
  background: var(--bg-primary);
}

.pricing-tabs {
  display: flex;
  gap: 0;
  border: 1px solid var(--border-gold);
  border-radius: var(--radius-sm);
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
  transition: all var(--transition);
  border: none;
  border-right: 1px solid var(--border-gold);
  font-family: var(--font-sans);
}

.pricing-tab:last-child { border-right: none; }

.pricing-tab.active {
  background: var(--accent-gold);
  color: var(--bg-primary);
  font-weight: 600;
}

.pricing-tab:not(.active):hover {
  background: rgba(201,168,76,0.1);
  color: var(--accent-gold);
}

.pricing-panel {
  display: none;
}
.pricing-panel.active {
  display: block;
  animation: fadePanel 0.3s ease;
}

@keyframes fadePanel {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

.pricing-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.9rem;
}

.pricing-table th {
  text-align: left;
  padding: 0.875rem 1rem;
  font-size: 0.65rem;
  font-weight: 500;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--accent-gold);
  border-bottom: 1px solid var(--border-gold);
  background: var(--bg-surface);
}

.pricing-table td {
  padding: 1rem;
  border-bottom: 1px solid var(--border-subtle);
  color: var(--text-primary);
  vertical-align: top;
}

.pricing-table tr:last-child td { border-bottom: none; }

.pricing-table tr:hover td {
  background: var(--bg-surface);
}

.pricing-table .price {
  color: var(--accent-gold);
  font-family: var(--font-serif);
  font-size: 1.05rem;
  font-weight: 600;
  white-space: nowrap;
}

.pricing-table .note {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.pricing-table .capacity {
  font-size: 0.78rem;
  color: var(--text-muted);
  white-space: nowrap;
}

.pricing-divider {
  margin: 2rem 0 1rem;
  display: flex;
  align-items: center;
  gap: 1rem;
}

.pricing-divider span {
  font-size: 0.65rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--accent-gold);
  white-space: nowrap;
}

.pricing-divider::before,
.pricing-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-gold);
}

.pricing-cta {
  margin-top: 3rem;
  text-align: center;
  padding: 2rem;
  border: 1px solid var(--border-gold);
  border-radius: var(--radius-md);
  background: var(--bg-surface);
}

.pricing-cta p {
  color: var(--text-muted);
  font-size: 0.875rem;
  margin-bottom: 1.25rem;
}

.pricing-cta .hotline {
  font-family: var(--font-serif);
  font-size: 1.8rem;
  font-style: italic;
  color: var(--accent-gold);
  display: block;
  margin-bottom: 1.25rem;
}
```

- [ ] **Step 2: Add pricing HTML** after rooms `</section>`:

```html
<section class="section" id="pricing">
  <div class="container">
    <div class="section-header fade-in">
      <span class="label">Bảng Giá · Pricing</span>
      <h2>Minh Bạch, Hợp Lý</h2>
    </div>

    <div class="pricing-tabs" role="tablist">
      <button class="pricing-tab active" data-tab="overnight" role="tab">Lưu Trú</button>
      <button class="pricing-tab" data-tab="activities" role="tab">F&B & Hoạt Động</button>
      <button class="pricing-tab" data-tab="events" role="tab">Sự Kiện</button>
    </div>

    <!-- TAB 1: Overnight -->
    <div class="pricing-panel active" id="tab-overnight">
      <div class="pricing-divider"><span>Lưu Trú Theo Đêm · Overnight Stay</span></div>
      <table class="pricing-table">
        <thead>
          <tr>
            <th>Loại Phòng</th>
            <th>Đơn Giá</th>
            <th>Sức Chứa</th>
            <th>Ghi Chú</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Triangle House (Tiêu Chuẩn)</td>
            <td><span class="price">300.000 đ</span></td>
            <td class="capacity">2–3 người</td>
            <td class="note">View vườn, giường đôi</td>
          </tr>
          <tr>
            <td>Circle House — Superior</td>
            <td><span class="price">600.000 đ</span></td>
            <td class="capacity">2–4 người</td>
            <td class="note">View hồ, tiện nghi cao cấp hơn</td>
          </tr>
          <tr>
            <td>E Đê Cozy — Deluxe</td>
            <td><span class="price">700.000 đ</span></td>
            <td class="capacity">2–4 người</td>
            <td class="note">Bao gồm bữa sáng</td>
          </tr>
          <tr>
            <td>VIP House — Premium Garden View</td>
            <td><span class="price">900.000 đ</span></td>
            <td class="capacity">3–5 người</td>
            <td class="note">Sân hiên riêng, view tốt nhất</td>
          </tr>
          <tr>
            <td>Bungalow Gia Đình</td>
            <td><span class="price">1.200.000 đ</span></td>
            <td class="capacity">4–6 người</td>
            <td class="note">Phòng rộng, full amenities</td>
          </tr>
          <tr>
            <td>Phòng Tập Thể</td>
            <td><span class="price">150.000 đ</span></td>
            <td class="capacity">10–20 người</td>
            <td class="note">Tính theo đầu người, giường tầng</td>
          </tr>
        </tbody>
      </table>

      <div class="pricing-divider"><span>Thuê Theo Giờ · Hourly Rental</span></div>
      <table class="pricing-table">
        <thead>
          <tr>
            <th>Gói</th>
            <th>Đơn Giá</th>
            <th>Thời Gian</th>
            <th>Ghi Chú</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Giờ Đầu Tiên</td>
            <td><span class="price">120.000 đ</span></td>
            <td class="capacity">1 giờ</td>
            <td class="note">Áp dụng toàn bộ loại phòng</td>
          </tr>
          <tr>
            <td>Combo 2 Giờ</td>
            <td><span class="price">200.000 đ</span></td>
            <td class="capacity">2 giờ</td>
            <td class="note">Tiết kiệm hơn giờ lẻ</td>
          </tr>
          <tr>
            <td>Giờ Phát Sinh Thêm</td>
            <td><span class="price">50.000 đ</span></td>
            <td class="capacity">/ giờ thêm</td>
            <td class="note">Sau combo 2H</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- TAB 2: Activities -->
    <div class="pricing-panel" id="tab-activities">
      <div class="pricing-divider"><span>F&B & Hoạt Động Trải Nghiệm</span></div>
      <table class="pricing-table">
        <thead>
          <tr>
            <th>Dịch Vụ</th>
            <th>Đơn Giá</th>
            <th>Đơn Vị</th>
            <th>Ghi Chú</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Cà phê & Nước uống</td>
            <td><span class="price">30.000–80.000 đ</span></td>
            <td class="capacity">/ phần</td>
            <td class="note">Quán cà phê tại chỗ</td>
          </tr>
          <tr>
            <td>Ăn uống theo yêu cầu</td>
            <td><span class="price">120.000–300.000 đ</span></td>
            <td class="capacity">/ người / bữa</td>
            <td class="note">Đặt trước 24h</td>
          </tr>
          <tr>
            <td>Đốt lửa trại (Campfire)</td>
            <td><span class="price">500.000–1.000.000 đ</span></td>
            <td class="capacity">/ buổi nhóm</td>
            <td class="note">Bao gồm củi, setup, 10–50 người</td>
          </tr>
          <tr>
            <td>Hái trái cây tại vườn</td>
            <td><span class="price">50.000–100.000 đ</span></td>
            <td class="capacity">/ người</td>
            <td class="note">Theo mùa</td>
          </tr>
          <tr>
            <td>Chụp ảnh / Check-in</td>
            <td><span class="price">200.000–500.000 đ</span></td>
            <td class="capacity">/ buổi</td>
            <td class="note">Sử dụng cảnh quan nông trại</td>
          </tr>
          <tr>
            <td>Cắm trại qua đêm</td>
            <td><span class="price">200.000–400.000 đ</span></td>
            <td class="capacity">/ đêm / người</td>
            <td class="note">Lều tự mang hoặc thuê</td>
          </tr>
          <tr>
            <td>Nông nghiệp trải nghiệm</td>
            <td><span class="price">100.000–200.000 đ</span></td>
            <td class="capacity">/ người</td>
            <td class="note">Trồng rau, chăm sóc cây</td>
          </tr>
          <tr>
            <td>Khu vui chơi trẻ em</td>
            <td><span class="price">Miễn phí</span></td>
            <td class="capacity">—</td>
            <td class="note">Tiện ích kèm theo</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- TAB 3: Events -->
    <div class="pricing-panel" id="tab-events">
      <div class="pricing-divider"><span>Team Building & Sự Kiện Doanh Nghiệp</span></div>
      <table class="pricing-table">
        <thead>
          <tr>
            <th>Gói Sự Kiện</th>
            <th>Đơn Giá</th>
            <th>Số Người</th>
            <th>Ghi Chú</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Team Building / Sự kiện nhỏ</td>
            <td><span class="price">3.000.000–5.000.000 đ</span></td>
            <td class="capacity">20–50 người</td>
            <td class="note">Cần đặt trước, tùy chỉnh theo yêu cầu</td>
          </tr>
          <tr>
            <td>Sự kiện doanh nghiệp lớn</td>
            <td><span class="price">5.000.000–10.000.000 đ</span></td>
            <td class="capacity">50–100 người</td>
            <td class="note">Setup đầy đủ, tùy chỉnh theo công ty</td>
          </tr>
          <tr>
            <td>Bán nông sản & sản phẩm</td>
            <td><span class="price">Theo giá thị trường</span></td>
            <td class="capacity">—</td>
            <td class="note">Cà phê, rau củ, trái cây tươi</td>
          </tr>
        </tbody>
      </table>
      <div style="margin-top:1.5rem; padding:1.25rem; background:var(--bg-surface); border-radius:var(--radius-md); border-left:3px solid var(--accent-gold);">
        <p style="font-size:0.82rem; color:var(--text-muted); line-height:1.7;">
          ✦ Giá sự kiện chưa bao gồm ăn uống và trang trí. Vui lòng liên hệ để được tư vấn gói phù hợp nhất cho đoàn của bạn.<br>
          ✦ Event pricing excludes catering and decoration. Contact us for a custom quote.
        </p>
      </div>
    </div>

    <!-- Hotline CTA -->
    <div class="pricing-cta fade-in">
      <p>Đặt phòng, hỏi giá, và nhận ưu đãi — Book now or inquire about packages</p>
      <a href="tel:0968987311" class="hotline">0968 987 311</a>
      <div style="display:flex; gap:1rem; justify-content:center; flex-wrap:wrap;">
        <a href="tel:0968987311" class="btn btn-gold">📞 Gọi Ngay</a>
        <a href="https://www.facebook.com/p/Hi%E1%BB%81n-L%C3%AA-Garden-61556329706262/" target="_blank" class="btn btn-outline">Facebook</a>
      </div>
    </div>
  </div>
</section>
```

- [ ] **Step 3: Add pricing tab JS** inside `<script>`:

```js
// Pricing tabs
document.querySelectorAll('.pricing-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.pricing-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.pricing-panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + target).classList.add('active');
  });
});
```

- [ ] **Step 4: Verify**

Scroll to pricing. Expected:
- 3 tabs: clicking each switches the table smoothly
- All prices display correctly with gold color
- Hotline `0968 987 311` visible below tables

---

### Task 8: Gallery Masonry

**Files:**
- Modify: `index.html` — gallery HTML + CSS + lightbox JS

- [ ] **Step 1: Add gallery CSS** inside `<style>`:

```css
/* ============================================
   GALLERY
============================================ */
#gallery {
  background: var(--bg-secondary);
}

.gallery-grid {
  columns: 3;
  column-gap: 1rem;
}

.gallery-item {
  break-inside: avoid;
  margin-bottom: 1rem;
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.gallery-item img {
  width: 100%;
  display: block;
  transition: transform var(--transition-slow);
}

.gallery-item::after {
  content: '⊕ Xem ảnh';
  position: absolute;
  inset: 0;
  background: rgba(13,31,19,0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--accent-gold);
  opacity: 0;
  transition: opacity var(--transition);
}

.gallery-item:hover img { transform: scale(1.06); }
.gallery-item:hover::after { opacity: 1; }

/* Lightbox */
.lightbox {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.92);
  z-index: 2000;
  align-items: center;
  justify-content: center;
}
.lightbox.open {
  display: flex;
}
.lightbox img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: var(--radius-sm);
  box-shadow: 0 32px 80px rgba(0,0,0,0.8);
}
.lightbox-close {
  position: absolute;
  top: 1.5rem;
  right: 2rem;
  font-size: 2rem;
  color: var(--text-muted);
  cursor: pointer;
  background: none;
  border: none;
  color: white;
  line-height: 1;
  transition: color var(--transition);
}
.lightbox-close:hover { color: var(--accent-gold); }

@media (max-width: 768px) {
  .gallery-grid { columns: 2; }
}
@media (max-width: 480px) {
  .gallery-grid { columns: 1; }
}
```

- [ ] **Step 2: Add gallery HTML** after pricing `</section>`:

```html
<section class="section" id="gallery">
  <div class="container">
    <div class="section-header fade-in">
      <span class="label">Thư Viện Ảnh · Gallery</span>
      <h2>Cảnh Quan Hiền Lê Garden</h2>
    </div>
    <div class="gallery-grid">
      <div class="gallery-item fade-in" data-src="https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=1200&q=90">
        <img src="https://images.unsplash.com/photo-1472214103451-9374bd1c798e?w=600&q=80" alt="View hồ panorama" loading="lazy">
        <!-- REPLACE: Aerial lake view -->
      </div>
      <div class="gallery-item fade-in" data-src="https://images.unsplash.com/photo-1510798831971-661eb04b3739?w=1200&q=90">
        <img src="https://images.unsplash.com/photo-1510798831971-661eb04b3739?w=600&q=80" alt="Triangle House" loading="lazy">
        <!-- REPLACE: Triangle House exterior -->
      </div>
      <div class="gallery-item fade-in" data-src="https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=1200&q=90">
        <img src="https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=600&q=80" alt="Vườn hoa cỏ may" loading="lazy">
        <!-- REPLACE: Cosmos flower field -->
      </div>
      <div class="gallery-item fade-in" data-src="https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=1200&q=90">
        <img src="https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?w=600&q=80" alt="Phòng nội thất" loading="lazy">
        <!-- REPLACE: Interior luxury room -->
      </div>
      <div class="gallery-item fade-in" data-src="https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1200&q=90">
        <img src="https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=600&q=80" alt="Khuôn viên xanh" loading="lazy">
        <!-- REPLACE: Garden grounds aerial -->
      </div>
      <div class="gallery-item fade-in" data-src="https://images.unsplash.com/photo-1440585657137-e3b3a4a0d7ed?w=1200&q=90">
        <img src="https://images.unsplash.com/photo-1440585657137-e3b3a4a0d7ed?w=600&q=80" alt="Cổng vào Hiền Lê Garden" loading="lazy">
        <!-- REPLACE: Entrance gate with lanterns -->
      </div>
      <div class="gallery-item fade-in" data-src="https://images.unsplash.com/photo-1537640538966-79f369143f8f?w=1200&q=90">
        <img src="https://images.unsplash.com/photo-1537640538966-79f369143f8f?w=600&q=80" alt="Circle House" loading="lazy">
        <!-- REPLACE: Circle House row -->
      </div>
      <div class="gallery-item fade-in" data-src="https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1200&q=90">
        <img src="https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=600&q=80" alt="Bình yên thiên nhiên" loading="lazy">
        <!-- REPLACE: Misty morning cabin scene -->
      </div>
    </div>
  </div>
</section>

<!-- Lightbox -->
<div class="lightbox" id="lightbox">
  <button class="lightbox-close" id="lightboxClose">✕</button>
  <img id="lightboxImg" src="" alt="">
</div>
```

- [ ] **Step 3: Add lightbox JS** inside `<script>`:

```js
// Gallery lightbox
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');

document.querySelectorAll('.gallery-item').forEach(item => {
  item.addEventListener('click', () => {
    lightboxImg.src = item.dataset.src;
    lightbox.classList.add('open');
    document.body.style.overflow = 'hidden';
  });
});

document.getElementById('lightboxClose').addEventListener('click', () => {
  lightbox.classList.remove('open');
  document.body.style.overflow = '';
});

lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox) {
    lightbox.classList.remove('open');
    document.body.style.overflow = '';
  }
});
```

- [ ] **Step 4: Verify**

Scroll to gallery. Expected:
- Masonry 3-column layout, staggered heights
- Hover: image zooms + gold overlay with "Xem ảnh"
- Click: lightbox opens full-res, click outside or ✕ to close

---

### Task 9: Final CTA + Footer

**Files:**
- Modify: `index.html` — CTA + footer HTML + CSS

**Interfaces:**
- Produces: `<section id="contact">` scroll anchor and page end

- [ ] **Step 1: Add CTA + footer CSS** inside `<style>`:

```css
/* ============================================
   FINAL CTA
============================================ */
#contact {
  position: relative;
  background: var(--bg-primary);
  overflow: hidden;
}

.cta-bg {
  position: absolute;
  inset: 0;
  background-image: url('https://images.unsplash.com/photo-1416879595882-3373a0480b5b?w=1200&q=60');
  /* REPLACE: cosmos flower field photo */
  background-size: cover;
  background-position: center;
  opacity: 0.12;
}

.cta-content {
  position: relative;
  z-index: 2;
  text-align: center;
  max-width: 700px;
  margin: 0 auto;
}

.cta-content .label {
  margin-bottom: var(--spacing-sm);
  display: block;
}

.cta-content h2 {
  font-family: var(--font-serif);
  font-size: clamp(2.5rem, 6vw, 4.5rem);
  font-weight: 300;
  font-style: italic;
  color: var(--text-primary);
  line-height: 1.1;
  margin-bottom: 0.5rem;
}

.cta-content h2 em {
  color: var(--accent-gold);
  font-style: italic;
}

.cta-sub {
  font-size: 1rem;
  color: var(--text-muted);
  margin-bottom: 2rem;
  font-style: italic;
  font-family: var(--font-serif);
}

.cta-hotline {
  font-family: var(--font-serif);
  font-size: 2.5rem;
  font-style: italic;
  color: var(--accent-gold);
  margin-bottom: 2rem;
  display: block;
  text-decoration: none;
  transition: color var(--transition);
}

.cta-hotline:hover { color: var(--accent-gold-lt); }

.cta-actions {
  display: flex;
  gap: 1rem;
  justify-content: center;
  flex-wrap: wrap;
}

/* ============================================
   FOOTER
============================================ */
footer {
  background: #070F09;
  border-top: 1px solid var(--border-gold);
  padding: 4rem var(--spacing-md) 2rem;
}

.footer-grid {
  display: grid;
  grid-template-columns: 1.5fr 1fr 1fr;
  gap: var(--spacing-lg);
  max-width: 1280px;
  margin: 0 auto;
  padding-bottom: 3rem;
  border-bottom: 1px solid var(--border-subtle);
}

.footer-brand-name {
  font-family: var(--font-serif);
  font-style: italic;
  font-size: 1.6rem;
  color: var(--accent-gold);
  margin-bottom: 0.5rem;
}

.footer-tagline {
  font-size: 0.75rem;
  color: var(--text-dim);
  letter-spacing: 0.1em;
  margin-bottom: 1.25rem;
}

.footer-contact p {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin-bottom: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.footer-contact a {
  color: var(--accent-gold);
  transition: color var(--transition);
}
.footer-contact a:hover { color: var(--accent-gold-lt); }

.footer-heading {
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--accent-gold);
  margin-bottom: 1.25rem;
}

.footer-links {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.footer-links li a {
  font-size: 0.85rem;
  color: var(--text-muted);
  transition: color var(--transition);
}

.footer-links li a:hover { color: var(--text-primary); }

.footer-bottom {
  max-width: 1280px;
  margin: 2rem auto 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: 1rem;
}

.footer-bottom p {
  font-size: 0.72rem;
  color: var(--text-dim);
}

.footer-social a {
  font-size: 0.72rem;
  color: var(--text-dim);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  transition: color var(--transition);
}

.footer-social a:hover { color: var(--accent-gold); }

@media (max-width: 768px) {
  .footer-grid { grid-template-columns: 1fr; gap: 2.5rem; }
  .footer-bottom { flex-direction: column; text-align: center; }
  .cta-hotline { font-size: 1.8rem; }
}
```

- [ ] **Step 2: Add CTA + footer HTML** after gallery `</section>`:

```html
<section class="section" id="contact">
  <div class="cta-bg"></div>
  <div class="container">
    <div class="cta-content fade-in">
      <span class="label">Đặt Phòng · Book Now</span>
      <h2>Bắt Đầu <em>Hành Trình</em><br>Của Bạn</h2>
      <p class="cta-sub">Begin Your Journey · Trải nghiệm trọn vẹn — Kỷ niệm đáng nhớ tại Hiền Lê Garden</p>
      <a href="tel:0968987311" class="cta-hotline">0968 987 311</a>
      <div class="cta-actions">
        <a href="tel:0968987311" class="btn btn-gold">📞 Gọi Đặt Phòng</a>
        <a href="https://www.facebook.com/p/Hi%E1%BB%81n-L%C3%AA-Garden-61556329706262/" target="_blank" class="btn btn-outline">Facebook Fanpage</a>
      </div>
    </div>
  </div>
</section>

<footer>
  <div class="footer-grid">
    <div>
      <div class="footer-brand-name">Hiền Lê Garden</div>
      <div class="footer-tagline">Farmstay · Buôn Ma Thuột · Đắk Lắk</div>
      <div class="footer-contact">
        <p>📞 <a href="tel:0968987311">0968 987 311</a></p>
        <p>📘 <a href="https://www.facebook.com/p/Hi%E1%BB%81n-L%C3%AA-Garden-61556329706262/" target="_blank">Facebook Fanpage</a></p>
        <p>📍 Buôn Ma Thuột, Đắk Lắk, Việt Nam</p>
      </div>
    </div>

    <div>
      <div class="footer-heading">Dịch Vụ</div>
      <ul class="footer-links">
        <li><a href="#rooms">Phòng Lưu Trú</a></li>
        <li><a href="#pricing">Thuê Theo Giờ</a></li>
        <li><a href="#pricing">F&B & Café</a></li>
        <li><a href="#pricing">Campfire & Glamping</a></li>
        <li><a href="#pricing">Team Building</a></li>
        <li><a href="#pricing">Sự Kiện & Tiệc</a></li>
      </ul>
    </div>

    <div>
      <div class="footer-heading">Trải Nghiệm</div>
      <ul class="footer-links">
        <li><a href="#experience">View Hồ Panorama</a></li>
        <li><a href="#experience">Vườn Hoa Cỏ May</a></li>
        <li><a href="#experience">Chụp Ảnh Check-in</a></li>
        <li><a href="#experience">Hái Trái Cây</a></li>
        <li><a href="#experience">Nông Nghiệm Trải Nghiệm</a></li>
        <li><a href="#experience">Khu Vui Chơi Trẻ Em</a></li>
      </ul>
    </div>
  </div>

  <div class="footer-bottom">
    <p>© 2026 Hiền Lê Garden. All rights reserved.</p>
    <div class="footer-social">
      <a href="https://www.facebook.com/p/Hi%E1%BB%81n-L%C3%AA-Garden-61556329706262/" target="_blank">Facebook</a>
    </div>
  </div>
</footer>
```

- [ ] **Step 3: Verify**

Open in browser and scroll to bottom. Expected:
- CTA section: flower field barely visible as bg, large italic headline, gold hotline, 2 buttons
- Footer: 3-column grid, gold brand name, all links functional
- `0968 987 311` is the only phone number on the entire page

---

### Task 10: Polish, Mobile & Final Verification

**Files:**
- Modify: `index.html` — final CSS tweaks + verify entire page

- [ ] **Step 1: Add remaining polish CSS** inside `<style>`:

```css
/* ============================================
   SCROLL INDICATOR ACTIVE NAV LINK
============================================ */
.nav-links a.active {
  color: var(--accent-gold);
}
.nav-links a.active::after {
  width: 100%;
}

/* ============================================
   SMOOTH STAGGER DELAYS FOR GRIDS
============================================ */
.features-grid .feature-card:nth-child(1) { transition-delay: 0s; }
.features-grid .feature-card:nth-child(2) { transition-delay: 0.08s; }
.features-grid .feature-card:nth-child(3) { transition-delay: 0.16s; }
.features-grid .feature-card:nth-child(4) { transition-delay: 0.24s; }
.features-grid .feature-card:nth-child(5) { transition-delay: 0.32s; }
.features-grid .feature-card:nth-child(6) { transition-delay: 0.40s; }
.features-grid .feature-card:nth-child(7) { transition-delay: 0.48s; }
.features-grid .feature-card:nth-child(8) { transition-delay: 0.56s; }
.features-grid .feature-card:nth-child(9) { transition-delay: 0.64s; }

.rooms-grid .room-card:nth-child(1) { transition-delay: 0s; }
.rooms-grid .room-card:nth-child(2) { transition-delay: 0.1s; }
.rooms-grid .room-card:nth-child(3) { transition-delay: 0.2s; }
.rooms-grid .room-card:nth-child(4) { transition-delay: 0s; }
.rooms-grid .room-card:nth-child(5) { transition-delay: 0.1s; }
.rooms-grid .room-card:nth-child(6) { transition-delay: 0.2s; }

/* ============================================
   SELECTION COLOR
============================================ */
::selection {
  background: rgba(201,168,76,0.3);
  color: var(--text-primary);
}

/* ============================================
   SCROLLBAR
============================================ */
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-track { background: var(--bg-primary); }
::-webkit-scrollbar-thumb { background: var(--border-gold); border-radius: 3px; }
::-webkit-scrollbar-thumb:hover { background: var(--accent-gold); }
```

- [ ] **Step 2: Add active nav link JS** inside `<script>`:

```js
// Active nav link on scroll
const sections = document.querySelectorAll('section[id]');
const navLinksAll = document.querySelectorAll('.nav-links a');

const sectionObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinksAll.forEach(a => a.classList.remove('active'));
      const active = document.querySelector(`.nav-links a[href="#${entry.target.id}"]`);
      if (active) active.classList.add('active');
    }
  });
}, { threshold: 0.4 });

sections.forEach(s => sectionObserver.observe(s));
```

- [ ] **Step 3: Full page verification checklist**

Open `index.html` in Chrome. Check each item:

| Check | Expected |
|---|---|
| Page background | `#0D1F13` dark forest green |
| Hero animation | 3-line text stagger, gold middle line |
| Sticky nav | Blurs after scroll, CTA button emerald |
| Mobile (<768px) | Hamburger shows, taps open overlay |
| Stats bar | Numbers count up on scroll into view |
| Feature grid | 3×3, hover gold underline animation |
| Room cards | 6 cards, lift on hover, gold price badges |
| Pricing tabs | Tab switching works, all prices correct |
| Hotline everywhere | Only `0968 987 311` — no other numbers |
| Gallery | Masonry 3-col, lightbox on click |
| CTA section | Faint flower bg, gold hotline link |
| Footer | 3 columns, all links working |
| Console | Zero JS errors |

- [ ] **Step 4: Final file save and confirm path**

Confirm output file exists at:
`/Users/apple/Documents/Vinhdx/HienLeGarden/LandingPage/index.html`

File should be a single self-contained HTML file openable directly in any browser.

---

## Self-Review

**Spec coverage:**
- ✅ Sticky nav with glassmorphism scroll effect
- ✅ Hero with stagger animation
- ✅ Stats bar with count-up
- ✅ Feature grid 9 cards
- ✅ Room showcase 6 room types with real pricing
- ✅ Pricing table 3 tabs with full data
- ✅ Gallery masonry + lightbox
- ✅ Final CTA section
- ✅ Footer with contact info
- ✅ Bilingual (Vietnamese primary, English secondary)
- ✅ Dark theme `#0D1F13` throughout
- ✅ Hotline `0968 987 311` only — confirmed in Task 7, 8, 9, 10
- ✅ Cormorant Garamond + Inter from Google Fonts CDN
- ✅ Mobile responsive at 768px
- ✅ Single `index.html` output

**Placeholder scan:** No TBD, no TODO. Image replacement instructions are explicit `<!-- REPLACE: ... -->` comments, not vague stubs.

**Type consistency:** No function name collisions — each JS block uses unique variable names (fadeObserver, counterObserver, sectionObserver).
