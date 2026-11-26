#!/bin/sh
# base_digest.sh <tag>: the digests of Home Assistant's Python base image for both architectures, as the
# lines for base-images.yaml (tag@digest, so a release builds from exactly that base; build.yaml keeps
# the same tags without the digest).
#   sh tools/base_digest.sh 3.12-alpine3.24
set -eu
tag=${1:?usage: base_digest.sh <tag, e.g. 3.12-alpine3.24>}
for arch in aarch64 amd64; do
  repo="home-assistant/$arch-base-python"
  token=$(curl -fsS "https://ghcr.io/token?scope=repository:$repo:pull" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
  digest=$(curl -fsSI -H "Authorization: Bearer $token" \
    -H "Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" \
    "https://ghcr.io/v2/$repo/manifests/$tag" | tr -d '\r' | sed -n 's/^docker-content-digest: *//Ip')
  echo "  $arch: ghcr.io/$repo:$tag@$digest"
done
