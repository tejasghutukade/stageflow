#!/bin/sh
set -eu
if [ "$(id -u)" = "0" ]; then
  if [ -S /var/run/docker.sock ]; then
    gid="$(stat -c '%g' /var/run/docker.sock)"
    if ! getent group "$gid" >/dev/null 2>&1; then
      groupadd --gid "$gid" stageflow-docker
    fi
    gname="$(getent group "$gid" | cut -d: -f1)"
    usermod -aG "$gname" stageflow
  fi
  home="$(getent passwd stageflow | cut -d: -f6)"
  exec setpriv --reuid=stageflow --regid=stageflow --init-groups --inh-caps=-all env HOME="${home:-/data}" "$@"
fi
exec "$@"
