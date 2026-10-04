# Single Brand Logo — Specification

**Request short name:** `single-brand-logo`
**Status:** Specification only. No code changes have been made.
**Date:** 2026-10-04

---

## 1. Problem

Every signed-in page renders two hotel logos at once:

- `public/components/header.html` — amber rounded badge (`w-9 h-9`) with `fa-solid fa-hotel`,
  the wordmark "Aurelia Grand Hotel" and the subtitle "Nairobi, Kenya", wrapped in a link to `/`.
- `public/components/sidebar.html` — a second amber badge (`w-8 h-8`) with `fa-solid fa-hotel`,
  the text "Aurelia Grand" and a role label (`#sidebar-role`), also wrapped in a link to `/`.

Both are on screen at the same time because `public/js/app.js` → `initApp({ sidebar: true })`
always loads `/components/header.html` and, when a dashboard is requested, also loads
`/components/sidebar.html`; `public/js/components/shell.js` then re-parents the sidebar next to
the main column. The result is the same brand mark twice, with two slightly different wordmarks
("Aurelia Grand Hotel" vs "Aurelia Grand").

### 1.1 Related finding that shapes the fix

On every dashboard page the `#app-header` slot appears **after** `#app-root` in the document:

```html
<!-- public/pages/admin/users.html (same shape in staff/reception.html,
     guest/bookings.html, guest/rooms.html, and ~30 other shell pages) -->
<div id="app-sidebar"></div>
<div id="sidebar-overlay"></div>
<div id="app-root"></div>     <!-- .page-shell, min-height: 100vh -->
<div id="app-header"></div>   <!-- header renders BELOW the shell -->
<div id="modal-root-slot"></div>
```

So today the header logo sits below a full-viewport-height shell. Simply deleting the sidebar brand
would leave the only logo effectively out of view on dashboards. The header must become the real
top bar of the dashboard, which is part of this spec.

---

## 2. Decisions (confirmed with the user)

| # | Decision |
|---|---|
| D1 | The **logo (icon badge + wordmark) lives in the header only.** The sidebar keeps no icon badge. |
| D2 | The sidebar's **top row becomes a slim, text-only strip** (hotel name, no icon), which *is* a link to `/`. |
| D3 | The **collapse/open toggle moves into the header**, on the far left, before the logo. The sidebar has no toggle button in its main flow. |
| D4 | On mobile the drawer additionally gets **its own close button inside the drawer**. |
| D5 | The **role label moves from the sidebar's top row into the sidebar footer**, next to name/email area. |
| D6 | The sidebar footer becomes **avatar + name + role**; the **email line is dropped**. |
| D7 | Scope is **dashboard pages only** (guest, staff, admin — everything built via `buildShell`). Public/marketing pages and the auth pages (`login.html`, `register.html`, and the JS-rendered equivalents in `public/js/pages/auth/*.js`) keep their own branding untouched. |
| D8 | **"Back to site"** link to `/` is added **in the sidebar footer, above Sign out** (not in the nav data). |
| D9 | On dashboard pages the header's **public nav links are hidden** (Home/Rooms/Restaurant/My Bookings/Reviews/Contact), as is the header's own mobile-menu hamburger. The sidebar toggle is the only menu control. |
| D10 | Hiding is done with **CSS keyed off a body/shell class**, not with logic inside `header.js`. |
| D11 | The header is moved above the shell by **editing every shell page's HTML** so `#app-header` comes first (declarative; no JS re-parenting for the header). |
| D12 | Desktop sidebar **stays full height (`top: 0; height: 100vh`) and scrolls under the sticky header**. No change to those two declarations. |
| D13 | The mobile drawer **starts below the header**: `top: 4rem` and `height: calc(100dvh - 4rem)`, so the logo and toggle remain visible while the drawer is open. |
| D14 | Collapsed state persistence is **kept** using the existing localStorage key `hotel.sidebar.collapsed`, but is **only restored at ≥1024px** — a phone always starts with the sidebar expanded/drawer closed. |
| D15 | Keyboard: **Ctrl/Cmd+B** toggles the sidebar; focus **moves into the drawer when it opens on mobile and returns to the toggle when it closes**. |
| D16 | Verification: extend `scripts/check-pages.mjs` to **assert exactly one logo per page**, and add **screenshots at desktop / collapsed / mobile widths**, written to a **git-ignored `artifacts/screenshots/`** directory. |

### 2.1 Accepted redundancy (flagged, not resolved away)

D2 + D8 together leave **two links to `/` inside the sidebar**: the top strip and the footer
"Back to site" item. This was chosen deliberately after being offered a single-link alternative.
Do not silently collapse them; if a future pass wants one link, that is a separate decision.

---

## 3. Files to change

| File | Change |
|---|---|
| `public/components/header.html` | Add sidebar-toggle button markup (hidden by default). Wrap the public `<nav>` and the mobile drawer so they can be hidden on dashboards. No change to the existing brand block. |
| `public/components/sidebar.html` | Remove the amber badge + `#sidebar-role` from the top row; top row becomes a slim text-only link to `/`. Footer: add role element, remove email element, add "Back to site" item above Sign out, and add a mobile-only close button in the drawer. |
| `public/js/components/sidebar.js` | Write the role into its new home in the footer; write into `#sidebar-role` (new location) instead of the top row; stop referencing the removed email node; wire the drawer close button. |
| `public/js/components/shell.js` | Add the shell/body class that drives the CSS (e.g. `document.body.classList.add('has-sidebar')`), so the header can hide its public nav. |
| `public/js/components/header.js` | Toggle button wiring (click, Ctrl/Cmd+B, `aria-expanded`, focus management). Header must keep working unchanged when no sidebar exists. |
| `public/css/app.css` | Hide header public nav + mobile menu when the shell class is present; mobile drawer `top: 4rem` / `height: calc(100dvh - 4rem)`; slim strip styling; collapsed-rail rules for the strip; header z-index vs sidebar stacking check. |
| `public/pages/**/*.html` (~30 shell pages: `admin/*`, `staff/*`, `guest/*` except the auth pages) | Move `<div id="app-header"></div>` **above** `<div id="app-root"></div>`. Public pages (`public/index.html`, `public/pages/amenity.html`, `auth/*.html`) keep their existing order. |
| `scripts/scaffold-pages.mjs`, `scripts/scaffold-guest-pages.mjs` | Update the HTML templates so newly scaffolded pages emit `#app-header` first. |
| `scripts/check-pages.mjs` | Add the one-logo assertion and the screenshot capture. |
| `.gitignore` | Add `artifacts/` so screenshots are never committed. |

---

## 4. Detailed requirements

### 4.1 Header (`public/components/header.html`)

- Brand block is **unchanged**: amber `w-9 h-9` badge, "Aurelia Grand Hotel", "Nairobi, Kenya", link to `/`.
- A new toggle button is the **first child** of the header's inner row (`flex items-center justify-between ... h-16`), to the left of the brand link.
  - `type="button"`, `id="sidebar-toggle-header"` (must not collide with the removed sidebar `#sidebar-toggle`; the old id disappears from the DOM entirely).
  - `hidden` by default, plus a class that the CSS reveals when the body carries the shell class.
  - Icon: `fa-solid fa-bars` — reuse the icon the sidebar used, so the control is visually unchanged.
  - `aria-label` toggles: desktop `Collapse sidebar` ⇄ `Expand sidebar`; mobile `Open navigation` ⇄ `Close navigation`.
  - `aria-expanded` reflects the current state (existing convention: `true` when the sidebar is expanded / drawer open).
  - `aria-controls="app-sidebar"`.
  - `title` tooltip matching the current action.
- The **desktop public `<nav aria-label="Main navigation">`** and the **mobile drawer `#mobile-menu` with `#mobile-menu-button`** must be hideable on dashboard pages. They are hidden purely by CSS, so `header.js` behaviour on public pages is untouched.
- The account menu, notification bell and sign-in/sign-up buttons are **unchanged**.

### 4.2 Sidebar (`public/components/sidebar.html`)

- **Top strip** (replaces the brand row):
  - Slim, single line, text only — "Aurelia Grand Hotel" (the full wordmark; the truncated "Aurelia Grand" goes away).
  - It **is a link to `/`**.
  - No `fa-hotel` icon, no amber badge, no role text.
  - Must reuse/extend the existing `.sidebar-user-info` class so `.sidebar.is-collapsed .sidebar-user-info { display: none; }` already hides it in the rail — or the equivalent selector is added if the class is not reused.
  - Keeps the `h-16 shrink-0` height and the bottom border so the strip does not change the sidebar's vertical rhythm more than necessary; reduced padding is acceptable if the strip is intentionally slimmer — decide at implementation and keep it visually a strip, not a second brand block.
- **Nav region** (`#sidebar-nav`) is otherwise unchanged: same role-driven `NAVIGATION` data in `sidebar.js`, same section headings, same `is-active` highlighting.
- **Mobile close button**: `type="button"`, placed inside the drawer at its top, **only visible below 1024px** (CSS), `aria-label="Close navigation"`, `fa-solid fa-xmark`. It is an addition to the header toggle, not a replacement.
- **Footer** (`.sidebar-footer`), in order:
  1. Identity row — `#sidebar-avatar` (unchanged), name `#sidebar-name` (unchanged), **role** label (moved here), and **the email line `#sidebar-email` is removed**.
  2. **"Back to site"** item — link to `/`, `nav-link` styling, an icon (e.g. `fa-arrow-left` / `fa-house`), with a `.nav-label` so it collapses with the rest.
  3. `#sidebar-logout` — unchanged behaviour and wording.
- `#sidebar-overlay` and its click-to-close behaviour are unchanged.

### 4.3 `public/js/components/sidebar.js`

- `#sidebar-role` write target moves to the footer element (keep the **same id** so the write is a one-line relocation, not a rename).
- Remove the write to `#sidebar-email`; `initSidebar` must not touch a node that no longer exists (guard or delete, not a silent no-op failure).
- Wire the new drawer close button to the same `setDrawerOpen(false)` path used by the overlay click and Escape.
- `NAVIGATION` role data is **not** modified (D8 puts "Back to site" in the footer, not in the nav).
- Keep `initSidebar(user)`'s signature and its `highlightCurrent` / `setupCollapse` / `setupLogout` behaviour.
- Nothing here may assume the top row exists.

### 4.4 Shell (`public/js/components/shell.js`)

- Set the shell marker class used by the CSS, e.g. `document.body.classList.add('has-sidebar')`, as part of building the shell (before `initApp`, so the first paint already has the right header).
- The existing sidebar/overlay re-parenting stays as it is.

### 4.5 Collapse / drawer behaviour (`sidebar.js` + `header.js`)

- Single source of truth for the toggle: the header button drives everything, whether it collapses the desktop rail or opens/closes the mobile drawer.
- Breakpoint logic unchanged: `window.matchMedia('(min-width: 1024px)')`.
- Desktop:
  - `setCollapsed(bool)` toggles `.is-collapsed`, updates the header button's `aria-label` / `aria-expanded`, and writes `localStorage['hotel.sidebar.collapsed']`.
  - Restoring the stored preference happens **only when `isDesktop()` is true** (D14).
- Mobile:
  - `setDrawerOpen(bool)` toggles `.is-open` on the sidebar and `.is-visible` on the overlay, and updates the header button's `aria-label` / `aria-expanded`.
  - Drawer close paths: header button, in-drawer close button, overlay click, **Escape**.
  - **Focus management**: on open, move focus to the first focusable element inside the drawer (or the close button); on close, return focus to the header toggle button.
  - A nav link click inside the drawer closes it (existing `nav_autoClose` behaviour, unchanged).
- Crossing the 1024px breakpoint clears `.is-open` / `.is-visible` so no half-applied state survives.
- Ctrl/Cmd+B: toggles the sidebar (desktop collapse, mobile drawer), must **not** fire while focus is in an input, textarea, select or contenteditable, and must be advertised via `title` and/or `aria-keyshortcuts`.
- Both header and sidebar modules must tolerate the other being absent: the header toggle is simply hidden on pages with no sidebar, and the sidebar code no-ops when `#sidebar-nav` is missing.

### 4.6 CSS (`public/css/app.css`)

- `.page-shell` / `.sidebar`: **unchanged** (`position: sticky; top: 0; width: 16rem; height: 100vh`) per D12 — the sidebar deliberately scrolls under the sticky header, so the header's stacking must stay above it (header is `z-30`; confirm the sidebar has no higher z-index on desktop, since the mobile `z-50` rule is inside a media query).
- **Dashboard header rules** (new): when the shell class is on `<body>`, hide the header's desktop public `<nav>` and `#mobile-menu` / `#mobile-menu-button`, and reveal the header sidebar toggle.
- **Mobile drawer** (inside the existing `max-width: 1023px` block): `top: 4rem;` and `height: calc(100dvh - 4rem);` (D13). `.is-open` translate behaviour, overlay and z-index stay as they are; the header must remain clickable above the drawer.
- **Slim strip**: new class; text-only, small (`text-xs`/`text-[11px]`), muted (`stone-400`/`stone-500`), truncated. Hidden in the collapsed rail via `.sidebar.is-collapsed`.
- **In-drawer close button**: `display: none` at ≥1024px, visible below.
- Collapsed-rail rules must keep the footer avatar and the Sign out icon visible (D-confirmed behaviour) and hide the strip text, "Back to site" label, and role text.
- Print styles untouched.

### 4.7 Page HTML

- In every shell page, the order becomes:

  ```html
  <div id="app-header"></div>
  <div id="app-sidebar"></div>
  <div id="sidebar-overlay"></div>
  <div id="app-root"></div>
  <div id="modal-root-slot"></div>
  ```

- **Unchanged**: `public/index.html`, `public/pages/amenity.html`, `public/pages/auth/*.html` (no shell, no sidebar), and any public page whose header already sits at the top.
- Scaffolding templates in `scripts/scaffold-pages.mjs` and `scripts/scaffold-guest-pages.mjs` emit the new order so future pages do not regress.

### 4.8 Accessibility

- Exactly one `h`-level landmark owner for the wordmark; the sidebar strip must not duplicate an `aria-label` that conflicts with the header's.
- Toggle button: real `<button type="button">`, `aria-controls="app-sidebar"`, accurate `aria-label` + `aria-expanded` + `title`, visible focus ring consistent with the rest of the header.
- Drawer: `aria-hidden` / inert background is **not** currently implemented — out of scope unless cheap; at minimum focus must not be trapped behind an open overlay, and Escape must work.
- Icon-only controls carry `aria-hidden="true"` on the `<i>` (existing convention).
- The removed `#sidebar-role` had no ARIA semantics; the new footer role text should read as plain text, not as a heading.

---

## 5. Out of scope

- Any change to the footer component's own logo (`public/components/footer.html`) — it is a third instance but sits below the fold and is a site-wide element, not a dashboard navigation one.
- The auth pages' centred brand cards (`login.html`, `register.html`, `forgot-password.js`, `reset-password.js`).
- Renaming or re-styling the brand itself (icon, colour, type). Only **placement and duplication** change.
- Moving the header in public pages, and any change to `markActiveNav` in `header.js` for public pages.
- Changing role navigation data (`NAVIGATION`) or the role → landing page map.

---

## 6. Acceptance criteria

1. On **every** dashboard page (guest, staff, admin) at ≥1024px there is exactly **one** `fa-hotel` badge on screen, and it is in the header.
2. The sidebar contains **no** `fa-hotel` badge; its top strip shows the text "Aurelia Grand Hotel" and links to `/`.
3. The header's public nav links and its mobile hamburger are **absent** on dashboard pages and **unchanged** on `public/index.html`, `public/pages/amenity.html` and the auth pages.
4. The header toggle collapses the sidebar to the 4.5rem rail on desktop and expands it back; the state survives a reload and a page-to-page navigation via `hotel.sidebar.collapsed`.
5. Below 1024px the header toggle opens the drawer, which sits **below** the header (`top: 4rem`) with the logo and toggle still visible; the in-drawer close button, the overlay click and Escape all close it; focus moves into the drawer on open and back to the toggle on close.
6. Ctrl/Cmd+B toggles the sidebar and does not fire while typing in a form field.
7. The sidebar footer shows avatar, name and role, shows **no** email, and shows a "Back to site" link above "Sign out". Sign out still works from the footer.
8. In the collapsed rail the strip text, role text, "Back to site" label and nav labels are hidden; the avatar and Sign out icon remain.
9. No console errors and no failed requests on any dashboard page (existing `check-pages.mjs` gate).
10. `#sidebar-role`, `#sidebar-name`, `#sidebar-avatar`, `#sidebar-nav`, `#sidebar-logout`, `#sidebar-overlay`, `#app-sidebar` continue to exist with the same ids, so `check-pages.mjs` and any page code that queries them keeps working. `#sidebar-email` is the only id intentionally removed.
11. Newly scaffolded pages (`npm run scaffold:pages`, `npm run scaffold:guest-pages`) emit the new element order.
12. Screenshots exist in the git-ignored `artifacts/screenshots/` directory for at least: guest dashboard (desktop expanded), guest dashboard (desktop collapsed), guest dashboard (mobile with drawer open), admin dashboard (desktop), and one public page for comparison.

---

## 7. Verification plan

1. `npm test` — unit tests (`tests/*.test.js`).
2. `npm run check:pages` — Playwright sweep of every dashboard page as a real signed-in user (guest, reception, housekeeping, restaurant, admin accounts).
   - **New assertions**: for each page, `document.querySelectorAll('#app-header .fa-hotel').length === 1` and the sidebar contains zero; the header toggle is visible at ≥1024px and hidden on `public/index.html`; `#sidebar-email` is absent and the footer role text is present.
   - **New screenshots** at three widths per representative page, written to `artifacts/screenshots/` (directory added to `.gitignore`).
3. `npm run check:flows`, `npm run check:auth`, `npm run check:amenities` — unchanged suites, run for regressions.
4. `npm run check` as the aggregate gate.
5. Manual desktop, collapsed and mobile pass with a real browser: keyboard-only toggle, Escape, focus return, drawer position relative to the header.

Environment note: `playwright-core`, a Chromium build, `mysql2`, `mysql`/`mysqld` and a `.env` are present, so the full suite should be runnable locally against a seeded database.

---

## 8. Risks and edge cases

- **Focus management on mobile** is the most likely source of regression: returning focus to the header toggle after an Escape or overlay close must not steal focus from a field the user has since focused.
- **z-index after the header moves above the shell**: the header is `sticky top-0 z-30` and the desktop sidebar has no z-index, so the sidebar's top 64px will pass under the header while scrolling (intended per D12) — but the sidebar's nav must never be unreachable behind it. The first nav section must remain scrollable into view.
- **Sticky stacking with the overlay**: the mobile overlay is `z-40` and the drawer `z-50`, both above the header's `z-30`; with the drawer now starting at `top: 4rem`, the header stays interactive — verify a header click while the drawer is open does the sane thing.
- **Collapsed rail + footer**: the footer has more content after adding the role and "Back to site"; in the 4.5rem rail these must all collapse to icons without wrapping or overflow.
- **Verified:** every page module reaches the sidebar through `buildShell()` (`grep` over `public/js/pages/**` shows no direct `initSidebar` import), so the shell class set in `shell.js` covers all ~30 dashboard pages. Re-check this if a page ever gains a bespoke shell.
- **Header without a sidebar** (public and auth pages) must not render a dead toggle button or throw in `header.js`.
- **Scaffold templates** are the easy thing to forget; without the update, the next generated page regresses to the old order.
- `check-pages.mjs` currently keys off `#page-content` for shell pages; if the header move changes what renders first, confirm the selector still matches.