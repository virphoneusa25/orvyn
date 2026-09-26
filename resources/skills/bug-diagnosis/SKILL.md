# Bug Diagnosis

Find the cause, then repair it.

1. Reproduce or inspect the failure with get_diagnostics or run_tests before editing anything.
2. Read the implicated files with read_file and search_codebase. Name a root cause only when a file, diagnostic, or failing check supports it.
3. Repair that cause with edit_file. Leave neighboring code alone.
4. Rerun the same failing check and report its result. Do not claim the bug is fixed if that rerun did not happen.
