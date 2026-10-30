#!/bin/sh
# Runs before nginx starts (official image: /docker-entrypoint.d/*.sh). Writes the load-balancer config with the
# Mac's IPv4 address, because host.docker.internal also resolves to an unreachable IPv6 address.
set -eu
API_HOST="$(getent ahostsv4 host.docker.internal | awk 'NR==1 { print $1 }')"
sed "s/__API_HOST__/${API_HOST}/g" /etc/nginx/cluster.conf.in > /etc/nginx/conf.d/default.conf
echo "resolve-api-host: booking-api instances at ${API_HOST}:4001 and ${API_HOST}:4002"
