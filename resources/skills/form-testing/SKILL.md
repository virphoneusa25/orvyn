# Form Testing

Use the form on the page. Do not send a real destructive submission.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. Open the form and check the fields that are visible. Fill with browser_type and use browser_click for validation or a safe submit. Capture browser_screenshot for disabled, loading, error, and success states that actually appear.
3. Do not use a destructive real-world submission unless the user explicitly allowed that submission. Do not invent values that pretend to be another person's credentials.
4. Report only the states the screenshot or session result showed. An HTTP response alone is not proof the form UI is correct.
