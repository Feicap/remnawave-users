#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Feicap/remnawave-users}"
APP_DIR="${APP_DIR:-/opt/remnawave-users}"
ACTIVE_FILE="$APP_DIR/.active_color"
EXTERNAL_ENV_SOURCE="/opt/.env"
COMPOSE_FILE="$APP_DIR/docker-compose.deploy.yml"

BLUE_BACKEND_PORT=18080
BLUE_FRONTEND_PORT=18081
GREEN_BACKEND_PORT=19080
GREEN_FRONTEND_PORT=19081

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
err() { printf '[ERROR] %s\n' "$*" >&2; }

compose_for_color() {
  local color="$1"
  local backend_port="$2"
  local frontend_port="$3"
  shift 3
  BACKEND_HOST_PORT="$backend_port" FRONTEND_HOST_PORT="$frontend_port" docker compose \
    --env-file "$APP_DIR/.env.prod" \
    --project-directory "$APP_DIR" \
    -p "remnawave-$color" \
    -f "$COMPOSE_FILE" \
    "$@"
}

require_sudo() {
  if ! sudo -n true 2>/dev/null; then
    log "sudo privileges are required"
    sudo -v
  fi
}

install_base_packages() {
  sudo apt update
  sudo apt install -y ca-certificates curl gnupg git nginx
}

install_docker_if_missing() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi

  log "Docker/Compose not found, installing"
  sudo install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  fi
  sudo chmod a+r /etc/apt/keyrings/docker.gpg

  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  sudo apt update
  sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo usermod -aG docker "$USER" || true
}

prepare_repo() {
  if [ ! -d "$APP_DIR/.git" ]; then
    log "Cloning repository into $APP_DIR"
    sudo mkdir -p "$(dirname "$APP_DIR")"
    sudo chown -R "$USER":"$USER" "$(dirname "$APP_DIR")"
    git clone "$REPO_URL" "$APP_DIR"
  fi

  cd "$APP_DIR"
  log "Updating repository"
  git fetch --all --prune
  git pull --ff-only
}

prepare_env_files() {
  if [ -f "$EXTERNAL_ENV_SOURCE" ]; then
    cp "$EXTERNAL_ENV_SOURCE" "$APP_DIR/.env.prod"
    log "Copied external env: $EXTERNAL_ENV_SOURCE -> $APP_DIR/.env.prod"
  elif [ ! -f "$APP_DIR/.env.prod" ]; then
    if [ -f "$APP_DIR/.env.prod.example" ]; then
      cp "$APP_DIR/.env.prod.example" "$APP_DIR/.env.prod"
      log "Created $APP_DIR/.env.prod from example"
    else
      err "Missing /opt/.env and $APP_DIR/.env.prod"
      exit 1
    fi
  fi

  cp "$APP_DIR/.env.prod" "$APP_DIR/backend/.env"
  log "Updated backend/.env from .env.prod"
}

read_domain_from_env() {
  DOMAIN="$(grep -E '^NGINX_SERVER_NAME=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- || true)"
  if [ -z "$DOMAIN" ]; then
    DOMAIN="jobrhyme.raspberryip.com"
  fi
  export DOMAIN
}

get_active_color() {
  if [ -f "$ACTIVE_FILE" ]; then
    ACTIVE_COLOR="$(cat "$ACTIVE_FILE")"
  else
    ACTIVE_COLOR="blue"
  fi

  if [ "$ACTIVE_COLOR" = "blue" ]; then
    TARGET_COLOR="green"
    TARGET_BACKEND_PORT=$GREEN_BACKEND_PORT
    TARGET_FRONTEND_PORT=$GREEN_FRONTEND_PORT
    OLD_COLOR="blue"
    OLD_BACKEND_PORT=$BLUE_BACKEND_PORT
    OLD_FRONTEND_PORT=$BLUE_FRONTEND_PORT
  else
    TARGET_COLOR="blue"
    TARGET_BACKEND_PORT=$BLUE_BACKEND_PORT
    TARGET_FRONTEND_PORT=$BLUE_FRONTEND_PORT
    OLD_COLOR="green"
    OLD_BACKEND_PORT=$GREEN_BACKEND_PORT
    OLD_FRONTEND_PORT=$GREEN_FRONTEND_PORT
  fi

  export ACTIVE_COLOR TARGET_COLOR TARGET_BACKEND_PORT TARGET_FRONTEND_PORT OLD_COLOR OLD_BACKEND_PORT OLD_FRONTEND_PORT
}

deploy_color() {
  local color="$1"
  local backend_port="$2"
  local frontend_port="$3"

  log "Deploying $color (backend:$backend_port frontend:$frontend_port)"
  compose_for_color "$color" "$backend_port" "$frontend_port" up -d --build --remove-orphans
}

wait_http() {
  local url="$1"
  local max_tries="${2:-90}"
  local i

  for i in $(seq 1 "$max_tries"); do
    if curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done

  return 1
}

print_target_debug() {
  log "Target containers status (${TARGET_COLOR}):"
  compose_for_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT" ps || true
  log "Backend logs (${TARGET_COLOR}):"
  compose_for_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT" logs backend --tail 120 || true
  log "Frontend logs (${TARGET_COLOR}):"
  compose_for_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT" logs frontend --tail 120 || true
  log "Postgres logs (${TARGET_COLOR}):"
  compose_for_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT" logs postgres --tail 80 || true
}

health_check_target() {
  sleep 3
  log "Checking frontend on ${TARGET_FRONTEND_PORT}"
  if ! wait_http "http://127.0.0.1:${TARGET_FRONTEND_PORT}" 60; then
    err "Frontend did not start on port ${TARGET_FRONTEND_PORT}"
    print_target_debug
    exit 1
  fi

  log "Checking backend on ${TARGET_BACKEND_PORT}"
  if ! wait_http "http://127.0.0.1:${TARGET_BACKEND_PORT}" 90; then
    err "Backend did not start on port ${TARGET_BACKEND_PORT}"
    print_target_debug
    exit 1
  fi
}

switch_nginx() {
  local conf_path="/etc/nginx/sites-available/remnawave"

  sudo tee "$conf_path" >/dev/null <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location /api/ {
        proxy_pass http://127.0.0.1:${TARGET_BACKEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    location / {
        proxy_pass http://127.0.0.1:${TARGET_FRONTEND_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF

  sudo ln -sf "$conf_path" /etc/nginx/sites-enabled/remnawave
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t
  sudo systemctl reload nginx

  echo "$TARGET_COLOR" > "$ACTIVE_FILE"
  log "Traffic switched to ${TARGET_COLOR}"
}

stop_old_color() {
  log "Stopping old color: ${OLD_COLOR}"
  compose_for_color "${OLD_COLOR}" "${OLD_BACKEND_PORT}" "${OLD_FRONTEND_PORT}" down || true
}

summary() {
  log "Done. Active color: ${TARGET_COLOR}"
  compose_for_color "${TARGET_COLOR}" "${TARGET_BACKEND_PORT}" "${TARGET_FRONTEND_PORT}" ps
}

main() {
  require_sudo
  install_base_packages
  install_docker_if_missing
  prepare_repo

  if [ ! -f "$COMPOSE_FILE" ]; then
    err "Missing $COMPOSE_FILE"
    exit 1
  fi

  prepare_env_files
  read_domain_from_env
  get_active_color
  deploy_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT"
  health_check_target
  switch_nginx
  stop_old_color
  summary
}

main "$@"
