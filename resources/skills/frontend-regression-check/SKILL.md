# Frontend Regression Check

Recheck the flows this change can break.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. From the files that changed, pick the major flows those files affect. Open them with browser_open and browser_navigate. Capture browser_screenshot. That is real browser evidence.
3. Stay on those flows. Do not wander into unrelated pages unless the change reaches them.
4. Report a regression only when the screenshot or navigation shows it. An HTTP response alone is not a passing flow.
