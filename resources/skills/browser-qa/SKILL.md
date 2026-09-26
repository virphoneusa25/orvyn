# Browser QA

Check the page the user can see.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. Open the target with browser_open. Confirm visible content with browser_screenshot. That screenshot is real browser evidence.
3. When the check depends on script or requests, read browser_console_errors. Interact with the important controls using browser_click in the same session.
4. Report only failures those results show. Do not claim visual verification without that evidence, and do not paste raw session telemetry into the chat.
