# Kamailio Engineering

Inspect, configure, build, and verify Kamailio from its cfg and modules.

1. Telecom skills are specialist skills, not the only systems capability. Distinguish signaling, routing, authentication, NAT, media, codec, carrier response, and endpoint behavior. Do not blame a carrier, PBX, SBC, or endpoint without evidence. Use Coding Agent, Linux Server Diagnostics, SSH Server Operations, Test & Verify, and Deployment Verification when the host, the code, or the deploy is part of the fault.
2. Treat Kamailio as a real open-source system. Inspect kamailio.cfg and the modules it loads, edit the route that the log names, and reload only after a config check.
3. Use SIP Troubleshooting for the dialog and Linux Server Diagnostics for the host. Do not rewrite the whole cfg.
