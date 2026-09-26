# Source Build & Compilation

Detect the build system from the project files and compile with that system's own command.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Recognize the build system that is present: Make, CMake, Autotools, Meson, Ninja, npm, pnpm, yarn, Cargo, Go modules, Maven, Gradle, Composer, or Python packaging. Do not invent build commands.
3. Run only the command the project files or official docs show, then report the result.
