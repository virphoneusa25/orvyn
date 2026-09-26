# Coding Agent

Implement a multi-file change in the existing codebase.

1. Inspect the relevant code with search_codebase and read_file, and get_project_outline when the area is unfamiliar.
2. Choose the smallest set of files that should change, and keep the project's current structure and naming.
3. Apply those edits with edit_file, or write_file only for a file the change actually needs. Do not invent extra files.
4. Run run_tests, and run_typecheck when the project has TypeScript. Report the result the tool returned.
5. Stop when the requested behavior is in place and that check result is known. If a check fails, fix only that failure.
