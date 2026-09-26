# TypeScript Engineering

Keep the types the project already relies on.

1. Read the surrounding types with read_file and search_codebase before editing.
2. Edit with edit_file. Preserve exported types. Do not add any unless the surrounding code already uses it for the same case.
3. Run run_typecheck on the project or package you changed.
4. Report the compiler result. Do not claim the types check if run_typecheck was not run.
