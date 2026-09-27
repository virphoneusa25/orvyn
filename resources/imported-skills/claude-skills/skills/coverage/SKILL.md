---
name: "coverage"
description: >-
  Analyze test coverage gaps. Use when user says "test coverage",
  "what's not tested", "coverage gaps", "missing tests", "coverage report",
  or "what needs testing".
---

# Analyze Test Coverage Gaps

Map all testable surfaces in the application and identify what's tested vs. what's missing.

## Steps

### 1. Map Application Surface

Use the `Explore` subagent to catalog:

**Routes/Pages:**
- Scan route definitions (Next.js `app/`, React Router config, Vue Router, etc.)
- List all user-facing pages with their paths

**Components:**
- Identify interactive components (forms, modals, dropdowns, tables)
- Note components with complex state logic

**API Endpoints:**
- Scan API route files or backend controllers
- List all endpoints with their methods

**User Flows:**
- Identify critical paths: auth, checkout, onboarding, core features
- Map multi-step workflows

### 2. Map Existing Tests

Scan all `*.spec.ts` / `*.spec.js` files:

- Extract which pages/routes are covered (by `page.goto()` calls)
- Extract which components are tested (by locator usage)
- Extract which API endpoints are mocked or hit
- Count tests per area

### 3. Generate Coverage Matrix

```
## Coverage Matrix

| Area | Route | Tests | Status |
|---|---|---|---|
| Auth | /login | 5 | ✅ Covered |
| Auth | /register | 0 | ❌ Missing |
| Auth | /forgot-password | 0 | ❌ Missing |
| Dashboard | /dashboard | 3 | ⚠️ Partial (no error states) |
| Settings | /settings | 0 | ❌ Missing |
| Checkout | /checkout | 8 | ✅ Covered |
```

### 4. Prioritize Gaps

Rank uncovered areas by business impact:

1. **Critical** — auth, payment, core features → test first
2. **High** — user-facing CRUD, search, navigation
3. **Medium** — settings, preferences, edge cases
4. **Low** — static pages, about, terms

### 5. Suggest Test Plan

For each gap, recommend:
- Number of tests needed
- Which template from `templates/` to use
- Estimated effort (quick/medium/complex)

```
## Recommended Test Plan

### Priority 1: Critical
1. /register (4 tests) — use auth/registration template — quick
2. /forgot-password (3 tests) — use auth/password-reset template — quick

### Priority 2: High
3. /settings (4 tests) — use settings/ templates — medium
4. Dashboard error states (2 tests) — use dashboard/data-loading template — quick
```

### 6. Auto-Generate (Optional)

Ask user: "Generate tests for the top N gaps? [Yes/No/Pick specific]"

If yes, invoke `/pw:generate` for each gap with the recommended template.

## Output

- Coverage matrix (table format)
- Coverage percentage estimate
- Prioritized gap list with effort estimates
- Option to auto-generate missing tests

<!-- ORVYN-ADAPTED-STEPS -->

1. Follow the domain workflow above. Read a file under references/, templates/, or assets/ only when the workflow names that file. Do not load every reference into the prompt.
2. Use these ORVYN tools when the workflow needs them: browser_open, browser_navigate, browser_click, browser_screenshot. Do not call a tool that is not registered.
3. Use the existing ORVYN Browser session from browser_open. Do not create a second browser. Playwright-style checks run through browser_navigate, browser_click, and browser_screenshot.
4. This skill does not ship a helper script.
5. Every declared capability used above maps to an ORVYN tool.
6. Do not activate unrelated skills for this workflow.
