# Safe Rollback

Show the target before you switch to it.

1. Identify the known-good state from git_log, the running release, or the file you read. Show that rollback target before changing anything. Do not invent a version or commit.
2. Use ssh_exec on a configured server alias, or terminal locally. Never call ssh_exec with an empty host. Prefer the app's existing rollback (previous release, previous image, previous unit).
3. Do not drop databases, delete volumes, or reset the worktree. Those are high-risk and wait for explicit authority. A targeted rollback is mutating and follows the access profile.
4. Verify after rollback: service status and a health check. Do not claim the rollback worked from the switch command's exit alone.
