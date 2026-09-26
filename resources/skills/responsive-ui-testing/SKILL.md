# Responsive UI Testing

Judge the layout from the resized page, not from the stylesheet.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. Open the page, then set browser_set_viewport to desktop, tablet, and mobile. Capture browser_screenshot after each preset. Those screenshots are real browser evidence.
3. Look for overflow, clipped content, broken navigation, bad stacking, and controls that cannot be read or tapped. Do not judge responsiveness from CSS source alone.
4. Report only what the three screenshots show. An HTTP response alone is not a responsive result.
