# Code Review

Review the change without modifying it.

1. Read the diff with git_diff and the surrounding code with read_file and search_codebase. Use git_log or find_symbol when history or a definition matters.
2. Report concrete issues. Each issue names the file and location you read, and why it matters.
3. Do not call edit_file, write_file, or delete_file unless the user explicitly asks for a change.
4. If you found no issue, say so and cite what you inspected. Do not invent problems.
