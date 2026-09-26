# TLS & Certificate Engineering

Inspect a certificate and the listener that presents it, without exposing the private key.

1. This skill guides the method. It does not limit the work to known products. For an unfamiliar application, inspect the repository structure, identify the language and runtime, identify the build system, locate the official readme and config examples, inspect the current configuration, identify the service and process layout, understand persistence and database requirements, understand network ports and endpoints, understand the deployment method, and then make the smallest justified change. Do not claim an application is unsupported merely because there is no dedicated skill for it. Do not invent build commands or install commands. Read the project files first.
2. Inspect expiration, hostname mismatch, chain issues, and the TLS listener. Check reverse-proxy TLS with the proxy skill when a proxy terminates it.
3. Never expose private keys. Do not paste key material into the reply.
