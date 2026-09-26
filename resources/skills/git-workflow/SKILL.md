# Git Workflow

Inspect the branch, then change git state only when asked.

1. Read git_status, git_branch, and git_diff before any git mutation. Use git_log when the recent history matters.
2. Do not reset, clean, or force-push. Do not run those operations through terminal either.
3. Use git_checkout or git_commit only when the user asked for that action. Commit the diff you just read, not unseen files.
4. Finish by reading git_status and git_diff again and reporting that output.
