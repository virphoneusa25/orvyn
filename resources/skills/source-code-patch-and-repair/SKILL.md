# Source Code Patch & Repair

Patch unfamiliar source by finding the call path and changing only that code.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Use Coding Agent together with this skill. Locate the relevant code, understand the call and data flow, and make minimal changes.
3. Compile, typecheck, or test with the project's own command, then verify runtime behavior. Do not claim the startup failure is fixed without that result.
