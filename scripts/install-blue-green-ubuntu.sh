#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Feicap/remnawave-users}"
APP_DIR="${APP_DIR:-/opt/remnawave-users}"
ACTIVE_FILE="$APP_DIR/.active_color"
TMP_DIR="$APP_DIR/.deploy-tmp"
EXTERNAL_ENV_SOURCE="/opt/.env"

BLUE_BACKEND_PORT=18080
BLUE_FRONTEND_PORT=18081
GREEN_BACKEND_PORT=19080
GREEN_FRONTEND_PORT=19081

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
err() { printf '[ERROR] %s\n' "$*" >&2; }

require_sudo() {
  if ! sudo -n true 2>/dev/null; then
    log "sudo privileges are required"
    sudo -v
  fi
}

check_external_env_at_start() {
  if [ -f "$EXTERNAL_ENV_SOURCE" ]; then
    log "Found external env file: $EXTERNAL_ENV_SOURCE"
  else
    log "External env file not found: $EXTERNAL_ENV_SOURCE"
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

choose_env_file() {
  if [ -f "$EXTERNAL_ENV_SOURCE" ]; then
    ENV_FILE="$APP_DIR/.env.prod"
    cp "$EXTERNAL_ENV_SOURCE" "$ENV_FILE"
    export ENV_FILE
    log "Copied external env to $ENV_FILE"
    return
  fi

  if [ -f "$APP_DIR/.env.prod" ]; then
    ENV_FILE="$APP_DIR/.env.prod"
  elif [ -f "$APP_DIR/.env.rpod" ]; then
    ENV_FILE="$APP_DIR/.env.rpod"
  elif [ -f "$APP_DIR/.env.prod.example" ]; then
    cp "$APP_DIR/.env.prod.example" "$APP_DIR/.env.prod"
    ENV_FILE="$APP_DIR/.env.prod"
    log "Created $APP_DIR/.env.prod from example. Fill secrets before production deploy"
  else
    err "Missing .env.prod/.env.rpod/.env.prod.example"
    exit 1
  fi

  export ENV_FILE
  log "Using env file: $ENV_FILE"
}

choose_compose_base() {
  if [ -f "$APP_DIR/docker-compose.prod.yml" ]; then
    COMPOSE_BASE="$APP_DIR/docker-compose.prod.yml"
  elif [ -f "$APP_DIR/docker-compose.yml" ]; then
    COMPOSE_BASE="$APP_DIR/docker-compose.yml"
  else
    err "Missing docker-compose.prod.yml and docker-compose.yml"
    exit 1
  fi

  export COMPOSE_BASE
  log "Using compose base: $COMPOSE_BASE"
}

read_domain_from_env() {
  DOMAIN="$(grep -E '^NGINX_SERVER_NAME=' "$ENV_FILE" | tail -n1 | cut -d '=' -f2- || true)"
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

render_compose_for_color() {
  local color="$1"
  local backend_port="$2"
  local frontend_port="$3"
  local out_file="$TMP_DIR/docker-compose.${color}.yml"

  sed \
    -E \
    -e "s|^([[:space:]]*-[[:space:]]*)\"?127\\.0\\.0\\.1:8080:8080\"?[[:space:]]*$|\\1\"127.0.0.1:${backend_port}:8080\"|g" \
    -e "s|^([[:space:]]*-[[:space:]]*)\"?127\\.0\\.0\\.1:8081:80\"?[[:space:]]*$|\\1\"127.0.0.1:${frontend_port}:80\"|g" \
    -e "s|^([[:space:]]*-[[:space:]]*)\"?8080:8080\"?[[:space:]]*$|\\1\"127.0.0.1:${backend_port}:8080\"|g" \
    -e "s|^([[:space:]]*-[[:space:]]*)\"?80:80\"?[[:space:]]*$|\\1\"127.0.0.1:${frontend_port}:80\"|g" \
    "$COMPOSE_BASE" > "$out_file"

  printf '%s' "$out_file"
}

deploy_target_color() {
  mkdir -p "$TMP_DIR"
  TARGET_COMPOSE="$(render_compose_for_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT")"
  export TARGET_COMPOSE

  mkdir -p "$APP_DIR/backend"
  cp "$ENV_FILE" "$APP_DIR/backend/.env"
  log "Updated backend/.env from $ENV_FILE"
  log "Rendered compose ports:"
  grep -nE '^[[:space:]]*-[[:space:]]*"?([0-9]{1,5}\.)?[0-9.:]+' "$TARGET_COMPOSE" || true

  log "Deploying ${TARGET_COLOR} (backend:${TARGET_BACKEND_PORT}, frontend:${TARGET_FRONTEND_PORT})"
  docker compose \
    --env-file "$ENV_FILE" \
    -p "remnawave-${TARGET_COLOR}" \
    -f "$TARGET_COMPOSE" \
    up -d --build --remove-orphans
}

wait_http() {
  local url="$1"
  local max_tries="${2:-40}"
  local i

  for i in $(seq 1 "$max_tries"); do
    if curl -sS -m 3 -o /dev/null "$url"; then
      return 0
    fi
    sleep 2
  done

  return 1
}

health_check_target() {
  log "Checking frontend on ${TARGET_FRONTEND_PORT}"
  if ! wait_http "http://127.0.0.1:${TARGET_FRONTEND_PORT}"; then
    err "Frontend did not start on port ${TARGET_FRONTEND_PORT}"
    exit 1
  fi

  log "Checking backend on ${TARGET_BACKEND_PORT}"
  if ! wait_http "http://127.0.0.1:${TARGET_BACKEND_PORT}"; then
    err "Backend did not start on port ${TARGET_BACKEND_PORT}"
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
  local old_compose
  old_compose="$(render_compose_for_color "$OLD_COLOR" "$OLD_BACKEND_PORT" "$OLD_FRONTEND_PORT")"

  log "Stopping old color: ${OLD_COLOR}"
  docker compose \
    --env-file "$ENV_FILE" \
    -p "remnawave-${OLD_COLOR}" \
    -f "$old_compose" \
    down || true
}

summary() {
  log "Done. Active color: ${TARGET_COLOR}"
  docker compose \
    --env-file "$ENV_FILE" \
    -p "remnawave-${TARGET_COLOR}" \
    -f "$TARGET_COMPOSE" \
    ps
}

main() {
  require_sudo
  check_external_env_at_start
  install_base_packages
  install_docker_if_missing
  prepare_repo
  choose_env_file
  choose_compose_base
  read_domain_from_env
  get_active_color
  deploy_target_color
  health_check_target
  switch_nginx
  stop_old_color
  summary
}

main "$@"
