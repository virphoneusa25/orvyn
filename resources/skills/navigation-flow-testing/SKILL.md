# Navigation Flow Testing

Follow the links and read the URL you land on.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. Open the start page with browser_open. Follow important routes with browser_click and browser_navigate, including back and forward when the flow has history.
3. A dead link or unexpected redirect is one the session URL shows. Capture browser_screenshot when the destination is visibly wrong. That is real browser evidence.
4. Do not call a route working because an HTTP response succeeded. The navigation result is the URL and page you reached.
