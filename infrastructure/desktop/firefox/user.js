// Firefox resource profile for the ORVYN cloud desktop.
//
// Measured problem: an animated marketing page burned ~180% of the host's
// 4 vCPUs inside the sandbox — Firefox repainted at full rate, x11grab
// captured 8fps of constantly-changing frames, and the encoder + control
// plane fought for what was left. These prefs cap the browser, not the
// user's ability to browse: animations still play, just at a sensible rate.
//
// prefs.js (this file is user.js: applied to the profile on every start)
user_pref("layout.frame_rate", 10);            // cap repaints; the stream is 8fps anyway
user_pref("dom.ipc.processCount", 1);          // one content process: 2vCPU container
user_pref("dom.ipc.processCount.webIsolated", 1);
user_pref("browser.tabs.remote.autostart", false);
user_pref("media.autoplay.default", 1);        // block autoplaying video/audio
user_pref("image.animation_mode", "normal");   // keep GIF/SVG animation, capped by frame rate
user_pref("browser.cache.disk.enable", true);
user_pref("browser.cache.disk.capacity", 262144); // 256MB max disk cache
user_pref("browser.sessionstore.interval", 300000); // session save every 5min, not 15s
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("toolkit.telemetry.enabled", false);
user_pref("datareporting.healthreport.uploadEnabled", false);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("app.update.enabled", false);
user_pref("app.update.auto", false);
user_pref("browser.ping-centre.telemetry", false);
user_pref("browser.newtabpage.activity-stream.feeds.telemetry", false);
user_pref("extensions.update.enabled", false);
user_pref("browser.discovery.enabled", false);     // no extension recommendations
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.page", 0);
user_pref("dom.push.connection.enabled", false);   // no push socket per session
user_pref("privacy.trackingprotection.enabled", true); // cheaper than loading trackers
user_pref("gfx.webrender.all", true);              // GPU path where available; fewer CPU raster falls
user_pref("media.peerconnection.enabled", false);  // no WebRTC in the sandbox browser
