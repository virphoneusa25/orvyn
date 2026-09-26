# Performance Diagnosis

Name the bottleneck from CPU, memory, disk, latency, or connection evidence before talking about scale.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Inspect CPU, memory, disk, I/O, latency, process state, application logs, connection counts, and database performance when those signals exist.
3. Do not recommend scaling before identifying the likely bottleneck.
