# ORVYN mission workload image for OpenShell sandboxes.
#
# The network policy templates (apps/worker/sandbox-policies) name binaries by
# their REAL paths in this image. Change a path here and the templates must
# change with it, or every allowed connection is denied:
#   /usr/local/bin/node   /usr/bin/python3.12   /usr/bin/git
#   /usr/lib/git-core/git-remote-http   /usr/bin/curl   /usr/bin/ssh
#
# Build (on the server, tag pinned — never :latest):
#   docker build -t orvyn/sandbox:0.1.2-1 infrastructure/openshell/sandbox-image
FROM node:20.19.5-bookworm-slim AS node

FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git python3 openssh-client coreutils \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && node --version && npm --version && git --version
# OpenShell refuses root workloads. uid/gid 1000 must match OPENSHELL_SANDBOX_UID
# on the worker, which hands the workspace files to this user.
RUN (userdel -r ubuntu 2>/dev/null || true) \
 && groupadd --gid 1000 sandbox && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash sandbox \
 && install -d -o sandbox -g sandbox /sandbox /workspace
WORKDIR /sandbox
USER sandbox
CMD ["/bin/bash"]
