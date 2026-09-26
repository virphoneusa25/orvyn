# Firewall Diagnostics

Read the rules before you touch them.

1. List the current rules first with ssh_exec on a configured server alias, or terminal locally (nft list ruleset, iptables -S, or ufw status). Never call ssh_exec with an empty host. This listing is diagnostic.
2. Never flush or reset the firewall. Do not run a blind flush or reset, including ufw reset, iptables -F, or nft flush ruleset.
3. Preserve SSH access. A rule that would drop the current session is high-risk and waits for explicit authority. Adding or deleting one rule is mutating and follows the access profile.
4. After an approved change, list the rules again and confirm the SSH path is still present. Do not claim the firewall is correct from the change command alone.
