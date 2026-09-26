# Refactor Safely

Change structure without changing behavior.

1. Read the code and its callers with read_file and search_codebase. Use find_symbol when a symbol is moving.
2. Run run_tests before editing when a test runner exists, and keep that result.
3. Make one small edit with edit_file. Keep observable behavior and the project's conventions.
4. Run run_tests again. Report both results. If the before-run was not applicable, say that instead of claiming a baseline.
