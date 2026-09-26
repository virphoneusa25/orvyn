# Service Integration

Connect an application to systemd, containers, a proxy, a database, Redis, a queue, or a network service.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Integrate with systemd, Docker, Docker Compose, reverse proxies, databases, Redis, queues, HTTP APIs, or TCP and UDP services. Use the existing Server and DevOps skills for the host-side work.
3. Verify the connection the application actually uses. Do not add a second service you did not find.
