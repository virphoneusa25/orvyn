# Dependency & Library Diagnosis

Identify a missing or conflicting library from the build or runtime error and the lock or manifest.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Read the manifest, lockfile, or pkg-config result the error names. Use Dependency Repair when the project is a language package the existing skill covers.
3. Do not add a dependency that the error did not mention.
