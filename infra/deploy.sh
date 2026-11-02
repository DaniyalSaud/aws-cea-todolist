#!/bin/bash
set -Eeuo pipefail

export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export AWS_PAGER=""
export DEBIAN_FRONTEND=noninteractive

# Use the EC2 instance role rather than local credential files.
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
unset AWS_PROFILE AWS_DEFAULT_PROFILE
export AWS_CONFIG_FILE=/dev/null
export AWS_SHARED_CREDENTIALS_FILE=/dev/null
export AWS_EC2_METADATA_DISABLED=false

registry="935173128637.dkr.ecr.us-east-1.amazonaws.com"
bucket="aws-cea-lab-dr"
deploy_dir="/opt/everyday"

image_tag="${1:-}"
if [ -z "$image_tag" ]; then
    image_tag="$(aws ssm get-parameter \
      --name /everyday/image-tag \
      --query Parameter.Value --output text)"
fi

[[ "$image_tag" =~ ^sha-[0-9a-f]{40}$ ]] || {
    echo "Invalid image tag" >&2
    exit 1
}

aws sts get-caller-identity --query Arn --output text

if ! command -v docker >/dev/null 2>&1 ||
   ! docker compose version >/dev/null 2>&1; then
    apt-get -o Acquire::Retries=3 update
    apt-get install -y docker.io docker-compose-v2
fi
systemctl enable --now docker

install -d -m 700 "$deploy_dir"
cd "$deploy_dir"
umask 077

aws s3 cp \
  "s3://${bucket}/deployment/${image_tag}/compose.aws.yaml" \
  compose.aws.yaml --only-show-errors

database_url="$(aws ssm get-parameter \
  --name /everyday/database-url --with-decryption \
  --query Parameter.Value --output text)"

printf '%s\n' \
  "BACKEND_IMAGE=${registry}/everyday-backend:${image_tag}" \
  "FRONTEND_IMAGE=${registry}/everyday-frontend:${image_tag}" \
  "DATABASE_URL=${database_url}" \
  "CORS_ORIGINS=http://everyday-alb-1968452079.us-east-1.elb.amazonaws.com" \
  > .env.aws

chmod 600 .env.aws
unset database_url

trap 'docker logout "$registry" >/dev/null 2>&1 || true' EXIT

aws ecr get-login-password |
  docker login --username AWS --password-stdin "$registry"

docker compose --env-file .env.aws -f compose.aws.yaml pull

docker compose --env-file .env.aws -f compose.aws.yaml \
  up -d --remove-orphans --wait --wait-timeout 180

curl -fsS --max-time 15 http://127.0.0.1/api/health
printf '\nDeployment healthy.\n'