# Database Migration

Change the schema through the migration framework already in the repo.

1. Find the schema and migration tool with search_files and read_file before writing a migration.
2. Add a forward migration with edit_file or write_file. Do not drop, truncate, or rewrite data unless the user explicitly permits it.
3. Run the project's migration command with terminal and report its output.
4. Do not claim the migration applied if that command was not run or did not succeed.
