# Ship code with proof

Make a code change and prove it works. The proof is observed evidence — a test run, a build, or a verification in the running app. Code inspection alone never proves correctness.

## Steps

1. Read the relevant code to understand the current behavior and locate the exact change needed. Use read_file and search_code — do not guess file contents.
2. Make the smallest correct change using edit_file (or write_file for new files). Keep the change scoped to the stated task.
3. Run the project's verification: run_tests if a test suite exists, run_typecheck for TypeScript, or a terminal command that exercises the changed code. If no verification exists, write a minimal test or script that proves the behavior.
4. If verification fails, diagnose from the actual error output, fix, and re-verify. Do not report success while any check is red.
5. Report what changed (files + summary), the verification command that was run, and the observed output proving it passed.

## Gate

After the edit, run_tests or run_typecheck or a terminal command exits 0. Attach the actual command output to the report — never claim success without observed evidence.
