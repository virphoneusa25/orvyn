# Log Analysis

Take a filtered excerpt, not the whole log.

1. Read a narrow window with ssh_exec on a configured server alias, or terminal or read_process_logs locally. Prefer journalctl --since, grep, or tail -n. Never call ssh_exec with an empty host.
2. Summarize repeated signatures. Keep the important timestamps and the error lines. Do not invent lines that were not in the output.
3. This skill is diagnostic. Do not restart services or delete logs. Log rotation and deletion wait for explicit authority.
4. If the output is still huge, narrow the filter and say what you dropped. Do not claim a root cause from an unfiltered dump you did not read.
