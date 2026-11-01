#!/bin/bash
# EC2 launch-template user data for the Web Tier on Ubuntu 24.04 LTS.
set -Eeuo pipefail
exec > >(tee -a /var/log/everyday-bootstrap.log) 2>&1
trap 'bootstrap_exit_code=$?; echo "Bootstrap failed at line ${LINENO} (exit ${bootstrap_exit_code})" >&2; exit "$bootstrap_exit_code"' ERR
export DEBIAN_FRONTEND=noninteractive

apt-get -o Acquire::Retries=3 -o APT::Update::Error-Mode=any update
apt-get -o Acquire::Retries=3 install -y docker.io docker-compose-v2 git curl ca-certificates
systemctl enable --now docker
usermod -aG docker ubuntu

install -d -o ubuntu -g ubuntu /home/ubuntu/everyday
if [ ! -d /home/ubuntu/everyday/.git ]; then
  runuser -u ubuntu -- git clone --branch main --depth 1 \
    https://github.com/DaniyalSaud/aws-cea-todolist.git /home/ubuntu/everyday
fi
cd /home/ubuntu/everyday

# Build from the repository root so Docker can copy the workspace package files.
docker build -f frontend/Dockerfile -t todo-web:initial .
docker network inspect todo-network >/dev/null 2>&1 || docker network create todo-network
if docker container inspect todo-web >/dev/null 2>&1; then
  docker rm -f todo-web
fi
docker run -d \
  --name todo-web \
  --restart unless-stopped \
  --network todo-network \
  -p 80:8080 \
  todo-web:initial

curl --fail --silent --show-error --retry 15 --retry-connrefused \
  --retry-delay 2 --max-time 5 http://127.0.0.1/healthz
printf '\nWeb Tier bootstrap completed.\n'
docker compose version
docker ps --filter name=todo-web
