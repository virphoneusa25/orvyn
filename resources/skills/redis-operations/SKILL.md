# Redis Operations

Read memory and persistence before you restart Redis.

1. Inspect systemctl status redis, redis-cli PING, INFO memory, and persistence with ssh_exec on a configured server alias, or terminal when Redis is local. Never call ssh_exec with an empty host.
2. Do not invent hosts, ports, or passwords. Do not print AUTH secrets.
3. FLUSHALL, FLUSHDB, and DEBUG SLEEP or a reset are high-risk and require explicit authority. A restart is mutating and follows the access profile.
4. After a repair, PING again and report INFO. A restart exit code is not connectivity.
