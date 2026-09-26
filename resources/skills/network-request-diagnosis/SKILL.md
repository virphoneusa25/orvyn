# Network Request Diagnosis

Classify the failed request from the session, not from a guess.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. Read failed requests with browser_console_errors and browser_evidence. Quote the method, URL, and status or error that result actually returned. That is real browser evidence.
3. Call it a frontend issue, API issue, CORS, auth, DNS, TLS, or server failure only when the status or error text supports that class. Do not assume the backend is at fault.
4. fetch_url may compare reachability from outside the page. An HTTP response alone does not explain the UI, and it is not visual verification.
