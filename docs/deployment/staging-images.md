# Staging container image release

The OVH staging host runs prebuilt backend and worker images from the private
`ghcr.io/virphoneusa25` registry. GitHub Actions builds each image from the
candidate commit, tags it with the full commit SHA, records its registry digest,
and supplies the digest reference to the staging deploy job. The host rejects
tag-only references and verifies both the registry digest and OCI revision
label before it replaces either application container.

The staging host does not build application images and does not prune Docker
cache. Deployment reports filesystem, inode, image, and Buildx cache use. It
warns below 20 GiB free and refuses to pull below the configurable 14 GiB
pre-pull reserve. It refuses to replace services if the pull leaves less than
the configurable 10 GiB operating reserve. Capacity should be expanded before
the warning threshold becomes routine; image retention and cache cleanup are
not used to conceal a capacity shortage.

Before updating the backend or worker, the deploy script tags the exact current
image IDs with a candidate-specific rollback reference. It pulls and verifies
both immutable candidate images before replacing either application service,
then starts only the backend and worker. PostgreSQL, Redis, Qdrant, their named
volumes, project data, and the staging network are not recreated. Failed
health, worker-registration, strict provider-preflight, or billing-preflight
checks restore both prior image references. Rollback references are retained
on the host and are not pruned by this workflow.

GitHub Actions uses its run-scoped token with `packages:write` for publishing
and `packages:read` for staging pulls. The pull credential is held in a
temporary, permission-restricted Docker configuration and removed after the
pull/deploy operation. It is not copied to an image, build argument, source
file, or long-lived host credential store.
