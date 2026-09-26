# Application Recovery

Restore a failed application to the last known-good process state without a blind reinstall.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Read the log and the unit or process command before restarting. Use Safe Rollback when a release must be reverted.
3. Do not reinstall the world. Restart or reload only the service the failure names, then verify it.
