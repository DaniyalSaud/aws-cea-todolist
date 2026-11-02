#!/bin/bash
set -Eeuo pipefail

exec > >(tee -a /var/log/everyday-bootstrap.log) 2>&1

export DEBIAN_FRONTEND=noninteractive
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1
export AWS_PAGER=""

apt-get -o Acquire::Retries=3 update
apt-get install -y curl unzip ca-certificates

if ! command -v aws >/dev/null 2>&1; then
    installer_dir=$(mktemp -d)

    curl -fsSL --retry 3 \
      https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip \
      -o "$installer_dir/awscli.zip"

    unzip -q "$installer_dir/awscli.zip" -d "$installer_dir"
    "$installer_dir/aws/install"
    rm -rf -- "$installer_dir"
fi

image_tag="$(aws ssm get-parameter \
  --name /everyday/image-tag \
  --query Parameter.Value --output text)"

[[ "$image_tag" =~ ^sha-[0-9a-f]{40}$ ]] || {
    echo "Invalid image tag" >&2
    exit 1
}

install -d -m 700 /opt/everyday

aws s3 cp \
  "s3://aws-cea-lab-dr/deployment/${image_tag}/deploy.sh" \
  /opt/everyday/deploy.sh \
  --only-show-errors

chmod 700 /opt/everyday/deploy.sh
bash /opt/everyday/deploy.sh "$image_tag"