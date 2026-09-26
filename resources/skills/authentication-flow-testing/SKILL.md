# Authentication Flow Testing

Use a session the user already authorized. Never invent credentials.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. Open the sign-in screen with browser_open and capture browser_screenshot. Test only an authorized, session-safe flow. Never invent credentials. Never type or repeat a password or token.
3. If the user has not provided a session-safe way in, stop at the screen you can see. Do not guess an account.
4. When the flow fails, use browser_console_errors and the screenshot to say whether the auth UI failed or the backend or session rejected it. An HTTP response alone is not that distinction.
