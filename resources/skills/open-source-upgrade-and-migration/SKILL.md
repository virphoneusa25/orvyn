# Open Source Upgrade & Migration

Upgrade or migrate an open-source application using its own migration notes.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Read the changelog and migration notes with read_document, git_log, or fetch_url before changing versions.
3. Use Upstream Project Analysis to separate upstream changes from local patches. Do not skip a migration step the notes require.
