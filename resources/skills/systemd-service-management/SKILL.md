# systemd Service Management

Read the unit before you restart it.

1. Inspect systemctl status, a short journal excerpt, and the unit configuration with ssh_exec on a configured server alias, or terminal when the unit is local. Never call ssh_exec with an empty host.
2. Restart or reload only the unit the evidence names. That is mutating and follows the access profile. Do not reboot the machine.
3. Run daemon-reload only when a unit file change requires it. Do not reload the daemon for a status check.
4. Verify the active state afterward with systemctl status. A successful restart command is not proof the service stayed up.
