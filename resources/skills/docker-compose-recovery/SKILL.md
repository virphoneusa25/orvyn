# Docker Compose Recovery

Inspect before you modify the stack.

1. Read the compose file with read_file and the failing service's logs before changing anything. Use terminal locally, or ssh_exec with a configured server alias when the stack is remote.
2. Make the smallest repair. Recreate only the necessary service. Do not bring the whole project down, and do not delete volumes.
3. docker compose up for one service is mutating and follows the access profile. Removing volumes or the whole stack is high-risk and waits for explicit approval.
4. Verify afterward: that service's status and a health check. Do not claim the stack recovered from the up command's exit alone.
