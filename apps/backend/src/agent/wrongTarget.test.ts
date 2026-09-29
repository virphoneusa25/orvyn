// The production false-success: ORION said "The desktop Firefox loaded it
// cleanly" while Firefox showed ORVYN's own start page. Verification of a
// browser target is a machine check, and the answer is held to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlTitle, matchBrowserTarget } from "./previewTarget";
import { groundSuccessClaims } from "../artifacts/claimValidator";

const URL = "https://orvyn.virphoneusa.com/api/v1/sites/d764c311-bac7-4973-a788-b20869a8be08/";
const EXPECTED = "NetGlobal — Owned Fiber, Subsea &amp; 5G Edge Networks";

test("the ORVYN desktop start page is WRONG_TARGET", () => {
  const m = matchBrowserTarget({ expectedUrl: URL, expectedTitle: EXPECTED, actualTitle: "ORVYN Desktop — Mozilla Firefox" });
  assert.equal(m.matched, false);
  assert.equal(m.reason, "WRONG_TARGET");
});

test("the customer page's title in the window matches", () => {
  assert.equal(htmlTitle("<head><title>NetGlobal — Owned Fiber, Subsea &amp; 5G Edge Networks</title></head>"), EXPECTED);
  const m = matchBrowserTarget({ expectedUrl: URL, expectedTitle: EXPECTED, actualTitle: "NetGlobal — Owned Fiber, Subsea & 5G Edge Networks — Mozilla Firefox" });
  assert.equal(m.matched, true);
});

test("another site, an error page, a new tab or an unchanged window never match", () => {
  assert.equal(matchBrowserTarget({ expectedUrl: URL, expectedTitle: EXPECTED, actualTitle: "VirPhone — Wholesale VoIP Carrier — Mozilla Firefox" }).reason, "WRONG_TARGET");
  assert.equal(matchBrowserTarget({ expectedUrl: URL, expectedTitle: EXPECTED, actualTitle: "Server Not Found — Mozilla Firefox" }).matched, false);
  assert.equal(matchBrowserTarget({ expectedUrl: URL, actualTitle: "New Tab — Mozilla Firefox" }).reason, "WRONG_TARGET");
  assert.equal(matchBrowserTarget({ expectedUrl: URL, actualTitle: "Some Page — Mozilla Firefox", titleBefore: "Some Page — Mozilla Firefox" }).reason, "UNCHANGED");
});

test("a desktop success claim without a matched target is rewritten, not reported", () => {
  const text = "The site is now live on the ORVYN Desktop, Royce. The desktop Firefox loaded it cleanly — title NetGlobal. Want me to scroll through the remaining sections?";
  const events = [{ type: "desktop.target", data: { matched: false, reason: "WRONG_TARGET", actualTitle: "ORVYN Desktop — Mozilla Firefox", expectedUrl: URL } }];
  const g = groundSuccessClaims(text, events);
  assert.equal(g.blocked, true);
  assert.doesNotMatch(g.text, /loaded it cleanly|now live on the ORVYN Desktop/);
  assert.match(g.text, /did not show the site \(it showed “ORVYN Desktop — Mozilla Firefox”\)/);
  // With a matched check the same claim stands.
  const ok = groundSuccessClaims(text, [{ type: "desktop.target", data: { matched: true } }]);
  assert.equal(ok.blocked, false);
  // Layout talk about desktop/mobile widths is not a desktop-browser claim.
  assert.equal(groundSuccessClaims("The page renders well on desktop and mobile.", []).blocked, false);
});
