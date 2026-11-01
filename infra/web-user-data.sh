#!/bin/bash
# EC2 launch-template user data for the container host on Ubuntu 24.04 LTS.
set -Eeuo pipefail
exec > >(tee -a /var/log/everyday-bootstrap.log) 2>&1
trap 'bootstrap_exit_code=$?; echo "Bootstrap failed at line ${LINENO} (exit ${bootstrap_exit_code})" >&2; exit "$bootstrap_exit_code"' ERR
export DEBIAN_FRONTEND=noninteractive

apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
apt-get -o Acquire::Retries=3 install -y docker.io docker-compose-v2 git curl ca-certificates unzip
systemctl enable --now docker
usermod -aG docker ubuntu

if ! command -v aws >/dev/null 2>&1; then
  awscli_arch="$(dpkg --print-architecture)"
  case "$awscli_arch" in
    amd64) awscli_arch=x86_64 ;;
    arm64) awscli_arch=aarch64 ;;
    *) echo "Unsupported architecture for AWS CLI: $awscli_arch" >&2; exit 1 ;;
  esac
  awscli_directory="$(mktemp -d)"
  curl --fail --location --silent --show-error --retry 3 \
    "https://awscli.amazonaws.com/awscli-exe-linux-${awscli_arch}.zip" \
    --output "${awscli_directory}/awscliv2.zip"
  unzip -q "${awscli_directory}/awscliv2.zip" -d "$awscli_directory"
  "${awscli_directory}/aws/install"
  rm -rf -- "$awscli_directory"
fi

install -d -o ubuntu -g ubuntu /home/ubuntu/everyday
if [ ! -d /home/ubuntu/everyday/.git ]; then
  runuser -u ubuntu -- git clone --branch main --depth 1 \
    https://github.com/DaniyalSaud/aws-cea-todolist.git /home/ubuntu/everyday
fi
cd /home/ubuntu/everyday

printf '\nContainer host bootstrap completed.\n'
aws --version
docker compose version
