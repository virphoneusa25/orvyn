# Staging container image release

The OVH staging host runs prebuilt backend and worker images from the private
`ghcr.io/virphoneusa25` registry. GitHub Actions builds each image from the
candidate commit, tags it with the full commit SHA, records its registry digest,
and supplies the digest reference to the staging deploy job. The host rejects
tag-only references and verifies both the registry digest and OCI revision
label before it replaces either application container.

The staging host does not build application images and does not prune Docker
cache. Deployment reports filesystem, inode, image, and Buildx cache use. The
default warning threshold is 20 GiB free; the default pre-pull reserve is
14 GiB; and the default post-pull operating reserve is 10 GiB. Operators can
set the repository Actions variables `ORVYN_STAGING_STORAGE_WARNING_KB`,
`ORVYN_STAGING_MIN_PREPULL_KB`, and `ORVYN_STAGING_MIN_POSTPULL_KB` to integer
KiB thresholds. The gate rejects nonnumeric or inconsistent values. Capacity
should be expanded before the warning threshold becomes routine; image
retention and cache cleanup are not used to conceal a capacity shortage.

Before updating the backend or worker, the deploy gate preserves a
candidate-specific rollback reference for each running application image. If
the worker's source image object has already been removed while its container
continues running, the pull-only gate requires no active or queued jobs and
captures the container filesystem with `docker export` (which excludes mounted
workspace volumes). It imports that filesystem with the worker startup
configuration and a source-image label, then verifies the image contains no
credential-like environment keys and can launch its worker files. The
credential-free image ID is the immutable rollback reference. It pulls and
verifies both candidate images before replacing either application service,
then starts only the backend and worker. PostgreSQL, Redis, Qdrant, their named
volumes, project data, and the staging network are not recreated. Failed
health, worker-registration, strict provider-preflight, or billing-preflight
checks restore both preserved image references. Rollback references are
retained on the host and are not pruned by this workflow.

GitHub Actions uses its run-scoped token with `packages:write` for publishing
and `packages:read` for staging pulls. The pull credential is held in a
temporary, permission-restricted Docker configuration and removed after the
pull/deploy operation. It is not copied to an image, build argument, source
file, or long-lived host credential store.
