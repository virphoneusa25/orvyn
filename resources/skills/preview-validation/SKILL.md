# Preview Validation

A process is not a preview until the page loads.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. Open the preview URL with browser_open. Capture browser_screenshot and confirm the expected application is what loaded. That screenshot is real browser evidence.
3. fetch_url can show the URL responded. An HTTP response alone does not mean the right application loaded.
4. Do not mark the preview available just because a process started. If the page is blank, wrong, or unreachable, say that.
