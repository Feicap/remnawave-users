#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Feicap/remnawave-users}"
APP_DIR="${APP_DIR:-/opt/remnawave-users}"
ACTIVE_FILE="$APP_DIR/.active_color"
EXTERNAL_ENV_SOURCE="/opt/.env"
COMPOSE_FILE="$APP_DIR/docker-compose.deploy.yml"
CERTBOT_WEBROOT="/var/www/certbot"

BLUE_BACKEND_PORT=18080
BLUE_FRONTEND_PORT=18081
GREEN_BACKEND_PORT=19080
GREEN_FRONTEND_PORT=19081
RETRIED_DB_RESET=0

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
  sudo apt install -y ca-certificates curl gnupg git nginx ufw certbot
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

configure_ufw() {
  if ! command -v ufw >/dev/null 2>&1; then
    log "ufw is not installed, skipping firewall configuration"
    return
  fi

  if ! sudo ufw status | grep -qi "Status: active"; then
    log "ufw is not active, skipping firewall rule changes"
    return
  fi

  log "Configuring ufw rules for web and blue/green internal ports"
  sudo ufw allow OpenSSH >/dev/null || true
  sudo ufw allow 80/tcp >/dev/null || true
  sudo ufw allow 443/tcp >/dev/null || true

  # These ports are for internal blue/green health checks and should not be reachable externally.
  sudo ufw deny 18080/tcp >/dev/null || true
  sudo ufw deny 18081/tcp >/dev/null || true
  sudo ufw deny 19080/tcp >/dev/null || true
  sudo ufw deny 19081/tcp >/dev/null || true
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

  local db_url
  local ssl_require
  local db_password
  local enable_https_raw
  db_url="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- || true)"
  ssl_require="$(grep -E '^DJANGO_DB_SSL_REQUIRE=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- || true)"
  enable_https_raw="$(grep -E '^ENABLE_HTTPS=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- || true)"
  enable_https_raw="${enable_https_raw,,}"
  db_password=""

  if [[ "$db_url" =~ ^postgres(ql)?://[^:]+:([^@]+)@ ]]; then
    db_password="${BASH_REMATCH[2]}"
  fi

  if [ -n "$db_password" ]; then
    if grep -qE '^POSTGRES_PASSWORD=' "$APP_DIR/.env.prod"; then
      sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$db_password|" "$APP_DIR/.env.prod"
    else
      echo "POSTGRES_PASSWORD=$db_password" >> "$APP_DIR/.env.prod"
    fi
    log "Synchronized POSTGRES_PASSWORD with DATABASE_URL"
  fi

  if [[ "$db_url" == *"@postgres:"* ]] && [[ "${ssl_require,,}" != "false" ]]; then
    if grep -qE '^DJANGO_DB_SSL_REQUIRE=' "$APP_DIR/.env.prod"; then
      sed -i 's/^DJANGO_DB_SSL_REQUIRE=.*/DJANGO_DB_SSL_REQUIRE=False/' "$APP_DIR/.env.prod"
    else
      echo "DJANGO_DB_SSL_REQUIRE=False" >> "$APP_DIR/.env.prod"
    fi
    log "Set DJANGO_DB_SSL_REQUIRE=False for local docker postgres"
  fi

  if [ "$enable_https_raw" = "true" ]; then
    if grep -qE '^DJANGO_SECURE_SSL_REDIRECT=' "$APP_DIR/.env.prod"; then
      sed -i 's/^DJANGO_SECURE_SSL_REDIRECT=.*/DJANGO_SECURE_SSL_REDIRECT=True/' "$APP_DIR/.env.prod"
    else
      echo "DJANGO_SECURE_SSL_REDIRECT=True" >> "$APP_DIR/.env.prod"
    fi
    if grep -qE '^DJANGO_SESSION_COOKIE_SECURE=' "$APP_DIR/.env.prod"; then
      sed -i 's/^DJANGO_SESSION_COOKIE_SECURE=.*/DJANGO_SESSION_COOKIE_SECURE=True/' "$APP_DIR/.env.prod"
    else
      echo "DJANGO_SESSION_COOKIE_SECURE=True" >> "$APP_DIR/.env.prod"
    fi
    if grep -qE '^DJANGO_CSRF_COOKIE_SECURE=' "$APP_DIR/.env.prod"; then
      sed -i 's/^DJANGO_CSRF_COOKIE_SECURE=.*/DJANGO_CSRF_COOKIE_SECURE=True/' "$APP_DIR/.env.prod"
    else
      echo "DJANGO_CSRF_COOKIE_SECURE=True" >> "$APP_DIR/.env.prod"
    fi
  else
    if grep -qE '^DJANGO_SECURE_SSL_REDIRECT=' "$APP_DIR/.env.prod"; then
      sed -i 's/^DJANGO_SECURE_SSL_REDIRECT=.*/DJANGO_SECURE_SSL_REDIRECT=False/' "$APP_DIR/.env.prod"
    else
      echo "DJANGO_SECURE_SSL_REDIRECT=False" >> "$APP_DIR/.env.prod"
    fi
    if grep -qE '^DJANGO_SESSION_COOKIE_SECURE=' "$APP_DIR/.env.prod"; then
      sed -i 's/^DJANGO_SESSION_COOKIE_SECURE=.*/DJANGO_SESSION_COOKIE_SECURE=False/' "$APP_DIR/.env.prod"
    else
      echo "DJANGO_SESSION_COOKIE_SECURE=False" >> "$APP_DIR/.env.prod"
    fi
    if grep -qE '^DJANGO_CSRF_COOKIE_SECURE=' "$APP_DIR/.env.prod"; then
      sed -i 's/^DJANGO_CSRF_COOKIE_SECURE=.*/DJANGO_CSRF_COOKIE_SECURE=False/' "$APP_DIR/.env.prod"
    else
      echo "DJANGO_CSRF_COOKIE_SECURE=False" >> "$APP_DIR/.env.prod"
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
  ENABLE_HTTPS="$(grep -E '^ENABLE_HTTPS=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- || true)"
  LETSENCRYPT_EMAIL="$(grep -E '^LETSENCRYPT_EMAIL=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- || true)"
  ENABLE_HTTPS="${ENABLE_HTTPS,,}"
  if [ -z "$ENABLE_HTTPS" ]; then
    ENABLE_HTTPS="false"
  fi
  export DOMAIN
  export ENABLE_HTTPS
  export LETSENCRYPT_EMAIL
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
  local host_header="${2:-}"
  local max_tries="${3:-90}"
  local i

  for i in $(seq 1 "$max_tries"); do
    if (( i == 1 || i % 5 == 0 )); then
      log "Health check attempt $i/$max_tries for $url"
    fi
    if [ -n "$host_header" ]; then
      if curl -fsS -m 3 -H "Host: $host_header" -o /dev/null "$url" 2>/dev/null; then
        return 0
      fi
    elif curl -fsS -m 3 -o /dev/null "$url" 2>/dev/null; then
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

backend_logs_tail() {
  compose_for_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT" logs backend --tail 200 2>&1 || true
}

maybe_recover_db_password_mismatch() {
  if [ "$RETRIED_DB_RESET" -eq 1 ]; then
    return 1
  fi

  local logs
  logs="$(backend_logs_tail)"
  if echo "$logs" | grep -q 'password authentication failed for user "postgres"'; then
    log "Detected postgres password mismatch for ${TARGET_COLOR}; recreating target stack volume and retrying once"
    compose_for_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT" down -v || true
    RETRIED_DB_RESET=1
    deploy_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT"
    return 0
  fi

  return 1
}

health_check_target() {
  sleep 3
  log "Checking frontend on ${TARGET_FRONTEND_PORT}"
  if ! wait_http "http://127.0.0.1:${TARGET_FRONTEND_PORT}" "$DOMAIN" 60; then
    err "Frontend did not start on port ${TARGET_FRONTEND_PORT}"
    print_target_debug
    exit 1
  fi

  log "Checking backend on ${TARGET_BACKEND_PORT}"
  if ! wait_http "http://127.0.0.1:${TARGET_BACKEND_PORT}" "$DOMAIN" 90; then
    if maybe_recover_db_password_mismatch; then
      log "Retrying backend health check after DB reset"
      if wait_http "http://127.0.0.1:${TARGET_BACKEND_PORT}" "$DOMAIN" 120; then
        return 0
      fi
    fi
    err "Backend did not start on port ${TARGET_BACKEND_PORT}"
    print_target_debug
    exit 1
  fi
}

write_nginx_http_config() {
  local conf_path="/etc/nginx/sites-available/remnawave"

  sudo tee "$conf_path" >/dev/null <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root ${CERTBOT_WEBROOT};
    }

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
}

write_nginx_https_config() {
  local conf_path="/etc/nginx/sites-available/remnawave"
  local cert_dir="/etc/letsencrypt/live/${DOMAIN}"

  sudo tee "$conf_path" >/dev/null <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location /.well-known/acme-challenge/ {
        root ${CERTBOT_WEBROOT};
    }

    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    ssl_certificate ${cert_dir}/fullchain.pem;
    ssl_certificate_key ${cert_dir}/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:10m;
    ssl_session_tickets off;

    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;

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
}

reload_nginx_with_site() {
  local conf_path="/etc/nginx/sites-available/remnawave"
  sudo ln -sf "$conf_path" /etc/nginx/sites-enabled/remnawave
  sudo rm -f /etc/nginx/sites-enabled/default
  sudo nginx -t
  sudo systemctl reload nginx
}

obtain_letsencrypt_cert() {
  if [ "$ENABLE_HTTPS" != "true" ]; then
    log "HTTPS disabled (ENABLE_HTTPS=$ENABLE_HTTPS)"
    return
  fi

  if [ -z "$LETSENCRYPT_EMAIL" ]; then
    err "ENABLE_HTTPS=true but LETSENCRYPT_EMAIL is empty"
    return
  fi

  sudo mkdir -p "$CERTBOT_WEBROOT/.well-known/acme-challenge"
  if [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ] && [ -f "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ]; then
    log "Let's Encrypt certificate already exists for ${DOMAIN}"
    return
  fi

  log "Requesting Let's Encrypt certificate for ${DOMAIN}"
  sudo certbot certonly --webroot -w "$CERTBOT_WEBROOT" \
    -d "$DOMAIN" \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos --non-interactive --keep-until-expiring
}

switch_nginx() {
  write_nginx_http_config
  reload_nginx_with_site
  obtain_letsencrypt_cert
  if [ "$ENABLE_HTTPS" = "true" ] && [ -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem" ] && [ -f "/etc/letsencrypt/live/${DOMAIN}/privkey.pem" ]; then
    write_nginx_https_config
    reload_nginx_with_site
  fi

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
  configure_ufw
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
