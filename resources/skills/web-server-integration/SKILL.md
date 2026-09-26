# Web Server Integration

Attach an application to the reverse proxy or web server its config already points at.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Use Nginx Operations or Caddy Operations for the server you actually find. Do not install a second proxy.
3. Preserve the existing server block. Verify the upstream the application listens on.
