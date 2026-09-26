# Network Service Engineering

Diagnose an arbitrary TCP or UDP service from listeners, DNS, routes, and the protocol you observed.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Inspect listeners, bind address, ports, DNS, routes, firewall, upstream and downstream connectivity, and protocol behavior.
3. Do not assume all network problems are firewall problems. Use Firewall Diagnostics only when a rule is in the evidence.
