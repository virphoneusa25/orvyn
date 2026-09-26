# Docker Operations

Look at the container before you change it.

1. Inspect with docker ps, docker inspect, and a short docker logs excerpt via terminal, or ssh_exec when Docker is on a configured server alias. Never call ssh_exec with an empty host.
2. Name the failing container only from that output. Do not invent image names, container ids, or ports.
3. docker start, restart, and a targeted rm of one stopped container are mutating and follow the access profile. Force-deleting volumes, docker system prune, and image wipes wait for explicit approval.
4. After a change, check that container's status and health again. Do not claim it is healthy from the change command's exit alone.
