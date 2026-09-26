# Dependency Repair

Fix a broken dependency without a broad upgrade.

1. Read the package manager files and lockfile with read_file and search_files. Identify the package that is actually failing.
2. Change only that dependency with edit_file. Do not bump unrelated packages or replace the package manager.
3. Install with terminal using the repo's package manager, then run run_typecheck or run_tests when the project has them.
4. Report the install and check output. Do not claim the tree is healthy if those commands were not run.
