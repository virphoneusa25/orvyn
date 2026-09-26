# PostgreSQL Operations

Confirm the database is up before you change it.

1. Inspect service status, connections, disk, and a short log excerpt with ssh_exec on a configured server alias, or terminal when Postgres is local. Never call ssh_exec with an empty host.
2. Use read-only SQL for diagnosis. Do not invent database names, roles, or passwords. Do not print connection strings.
3. DROP DATABASE, DROP TABLE, TRUNCATE, and DELETE without a where clause are destructive and require explicit authority. Restarts are mutating and follow the access profile.
4. After a repair, verify Postgres accepts connections again. A restart exit code is not availability.
