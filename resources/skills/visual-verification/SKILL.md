# Visual Verification

The proof is the picture of the page, not the diff.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. After the UI change, capture browser_screenshot and read browser_evidence for that same session. That screenshot is real browser evidence.
3. Compare the requested visible state with what the screenshot shows. Say what matches and what does not.
4. Do not claim the UI is fixed from code inspection only. An HTTP response alone is not visual verification.
