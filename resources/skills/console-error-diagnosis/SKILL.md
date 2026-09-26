# Console Error Diagnosis

Read the console for this page, then trace only the errors that block it.

1. Use the existing ORVYN Browser session from browser_open. Do not create a second browser.
2. Open the page and call browser_console_errors. Treat warnings as warnings. Cite a message only if it was in that result. This is real browser evidence.
3. If a stack names an application file, read that file with read_file or search_codebase. Do not invent a stack frame.
4. After a repair, open the same page and read the console again. The error is gone only when that later read no longer shows it.
