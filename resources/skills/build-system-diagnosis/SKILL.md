# Build System Diagnosis

Explain a build failure from the generator and the error, then change only the failing part.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Use Source Build and Compilation to name the generator. Quote the failing target from the build log.
3. Do not invent a clean rebuild of the whole tree when one target failed.
