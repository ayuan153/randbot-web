#!/usr/bin/env bash
set -euo pipefail

# Uses docker buildx (a docker-container builder) to cross-build linux/amd64
# via QEMU and push. Pinned because SageMaker is x86_64 / dev Mac is arm64.

ACCOUNT_ID="${ACCOUNT_ID:-516246239933}"
REGION="${REGION:-us-east-1}"
REPO="${REPO:-randbats-training}"
TAG="${TAG:-latest}"
PROFILE="${PROFILE:-randbot}"
IMAGE_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${REPO}:${TAG}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

aws ecr get-login-password --region "$REGION" --profile "$PROFILE" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"

docker buildx build \
  --platform linux/amd64 \
  -f "$REPO_ROOT/self-play/Dockerfile" \
  -t "$IMAGE_URI" \
  --push \
  "$REPO_ROOT"

echo "Pushed: $IMAGE_URI"
