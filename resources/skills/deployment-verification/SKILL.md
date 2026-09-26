# Deployment Verification

A finished deploy command is not a healthy deploy.

1. Check process, service, or container status and the expected listening port with ssh_exec on a configured server alias, or terminal locally. Never call ssh_exec with an empty host.
2. Read a short log excerpt for errors. Request the health endpoint or application URL with fetch_url and report the status you received.
3. These checks are diagnostic. Do not restart or redeploy from this skill unless the user asked for a repair.
4. Do not call the deployment healthy from the deploy command's exit alone. Health requires the status, the port, and a response or an explicit statement that one of those checks failed.
