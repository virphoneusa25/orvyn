# Website Build Verification

The build is verified only when the page has been opened.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. Run the project build with terminal and report that output. If a preview process is required, start_process may start it. A started process is not verification.
3. Open the actual page with browser_open. Confirm the expected visible content with browser_screenshot. Read browser_console_errors for console errors and critical failed requests. That screenshot and console read are real browser evidence.
4. fetch_url may show the URL responds. An HTTP response alone is not full verification. Do not finish until the opened page has been checked.
