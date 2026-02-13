#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Feicap/remnawave-users}"
APP_DIR="${APP_DIR:-/opt/remnawave-users}"
ACTIVE_FILE="$APP_DIR/.active_color"
EXTERNAL_ENV_SOURCE="/opt/.env"
COMPOSE_FILE="$APP_DIR/docker-compose.deploy.yml"
CERTBOT_WEBROOT="/var/www/certbot"
SCRIPT_RAW_URL="${SCRIPT_RAW_URL:-https://raw.githubusercontent.com/Feicap/remnawave-users/main/scripts/install-blue-green-ubuntu.sh}"
SHARED_PROJECT="${SHARED_PROJECT:-remnawave-shared}"
SHARED_NETWORK="${SHARED_NETWORK:-remnawave-shared-db}"
SHARED_DB_CONTAINER="${SHARED_DB_CONTAINER:-remnawave-shared-postgres}"

BLUE_BACKEND_PORT=18080
BLUE_FRONTEND_PORT=18081
GREEN_BACKEND_PORT=19080
GREEN_FRONTEND_PORT=19081
RETRIED_DB_RESET=0
UPDATE_AVAILABLE=0

CURL_REFRESH_ARGS=(
  -fsSL
  --connect-timeout 10
  --max-time 60
  --retry 3
  -H "Cache-Control: no-cache, no-store, must-revalidate"
  -H "Pragma: no-cache"
  -H "Expires: 0"
)

log() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
err() { printf '[ERROR] %s\n' "$*" >&2; }
COLOR_RESET='\033[0m'
COLOR_YELLOW='\033[1;33m'
COLOR_ORANGE='\033[38;5;208m'

setup_interactive_tty() {
  if [ -t 0 ] && [ -t 1 ]; then
    MENU_INPUT="/dev/stdin"
    MENU_OUTPUT="/dev/stdout"
    return
  fi

  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    MENU_INPUT="/dev/tty"
    MENU_OUTPUT="/dev/tty"
    return
  fi

  err "Interactive input is unavailable. Run script from a terminal."
  exit 1
}

menu_print() {
  printf "%b\n" "$1" > "$MENU_OUTPUT"
}

menu_item() {
  local num="$1"
  local text="$2"
  menu_print "${COLOR_ORANGE}${num}${COLOR_RESET}. ${COLOR_YELLOW}${text}${COLOR_RESET}"
}

running_from_pipe_or_stdin() {
  local src="${BASH_SOURCE[0]:-}"
  case "$src" in
    /dev/fd/*|/proc/self/fd/*|-|stdin|"")
      return 0
      ;;
  esac
  return 1
}

extract_owner_repo_from_url() {
  local url="$1"
  local clean
  clean="$(printf '%s' "$url" | sed -E 's#^https?://github.com/##; s#^git@github.com:##; s#\.git$##')"
  if printf '%s' "$clean" | grep -Eq '^[^/]+/[^/]+$'; then
    printf '%s' "$clean"
    return 0
  fi
  return 1
}

resolve_fresh_script_url() {
  local owner_repo
  local head_sha

  if ! owner_repo="$(extract_owner_repo_from_url "$REPO_URL")"; then
    printf '%s' "$SCRIPT_RAW_URL"
    return 0
  fi

  if command -v git >/dev/null 2>&1; then
    head_sha="$(git ls-remote "$REPO_URL" refs/heads/main 2>/dev/null | awk 'NR==1 {print $1}')"
    if [ -n "$head_sha" ]; then
      printf 'https://raw.githubusercontent.com/%s/%s/scripts/install-blue-green-ubuntu.sh' "$owner_repo" "$head_sha"
      return 0
    fi
  fi

  printf '%s' "$SCRIPT_RAW_URL"
}

append_cache_bust() {
  local url="$1"
  local ts
  ts="$(date +%s)"
  if [[ "$url" == *"?"* ]]; then
    printf '%s&ts=%s' "$url" "$ts"
  else
    printf '%s?ts=%s' "$url" "$ts"
  fi
}

auto_refresh_script() {
  if [ "${SCRIPT_AUTO_REFRESHED:-0}" = "1" ]; then
    return
  fi

  if ! command -v curl >/dev/null 2>&1; then
    return
  fi

  local refresh_url
  local fetch_url
  local tmp_script

  refresh_url="$(resolve_fresh_script_url)"
  fetch_url="$(append_cache_bust "$refresh_url")"

  if running_from_pipe_or_stdin; then
    log "Running via pipe/stdin, forcing latest script refresh"
  fi

  tmp_script="$(mktemp /tmp/remnawave-install.XXXXXX.sh)"
  if curl "${CURL_REFRESH_ARGS[@]}" "$fetch_url" -o "$tmp_script"; then
    log "Loaded latest script version from GitHub"
    chmod +x "$tmp_script"
    SCRIPT_AUTO_REFRESHED=1 bash "$tmp_script" "$@"
    local exit_code=$?
    rm -f "$tmp_script"
    exit "$exit_code"
  fi

  err "Failed to fetch latest script version, continuing with current copy"
  rm -f "$tmp_script"
}

check_script_update() {
  UPDATE_AVAILABLE=0

  if ! command -v curl >/dev/null 2>&1; then
    return
  fi

  local local_script=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -r "${BASH_SOURCE[0]}" ]; then
    local_script="${BASH_SOURCE[0]}"
  elif [ -r "$APP_DIR/scripts/install-blue-green-ubuntu.sh" ]; then
    # Fallback for "curl | bash" where BASH_SOURCE can be a closed /dev/fd path.
    local_script="$APP_DIR/scripts/install-blue-green-ubuntu.sh"
  else
    return
  fi

  local refresh_url
  local fetch_url
  local tmp_script local_sum remote_sum
  refresh_url="$(resolve_fresh_script_url)"
  fetch_url="$(append_cache_bust "$refresh_url")"
  tmp_script="$(mktemp /tmp/remnawave-update-check.XXXXXX.sh)"
  if ! curl "${CURL_REFRESH_ARGS[@]}" "$fetch_url" -o "$tmp_script"; then
    rm -f "$tmp_script"
    return
  fi

  local_sum="$(sha256sum "$local_script" | awk '{print $1}')"
  remote_sum="$(sha256sum "$tmp_script" | awk '{print $1}')"
  rm -f "$tmp_script"

  if [ -n "$local_sum" ] && [ -n "$remote_sum" ] && [ "$local_sum" != "$remote_sum" ]; then
    UPDATE_AVAILABLE=1
  fi
}

update_script_now() {
  local refresh_url
  local fetch_url
  local tmp_script
  refresh_url="$(resolve_fresh_script_url)"
  fetch_url="$(append_cache_bust "$refresh_url")"
  tmp_script="$(mktemp /tmp/remnawave-install-update.XXXXXX.sh)"
  if ! curl "${CURL_REFRESH_ARGS[@]}" "$fetch_url" -o "$tmp_script"; then
    err "Не удалось скачать обновление скрипта"
    rm -f "$tmp_script"
    return 1
  fi

  chmod +x "$tmp_script"
  log "Запуск обновлённой версии скрипта"
  SCRIPT_AUTO_REFRESHED=1 bash "$tmp_script"
  local exit_code=$?
  rm -f "$tmp_script"
  exit "$exit_code"
}

menu_read() {
  local prompt="$1"
  local __resultvar="$2"
  local value
  printf "%s" "$prompt" > "$MENU_OUTPUT"
  if ! IFS= read -r value < "$MENU_INPUT"; then
    return 1
  fi
  printf -v "$__resultvar" "%s" "$value"
}

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

compose_shared_db() {
  docker compose \
    --env-file "$APP_DIR/.env.prod" \
    --project-directory "$APP_DIR" \
    -p "$SHARED_PROJECT" \
    -f "$COMPOSE_FILE" \
    --profile shared-db \
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

is_monitoring_enabled() {
  local enable_monitoring
  enable_monitoring="$(grep -E '^ENABLE_MONITORING=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  enable_monitoring="${enable_monitoring,,}"
  if [ -z "$enable_monitoring" ]; then
    enable_monitoring="true"
  fi
  [ "$enable_monitoring" = "true" ]
}

is_k8s_app_deploy_enabled() {
  local enable_k8s_app_deploy
  enable_k8s_app_deploy="$(grep -E '^ENABLE_K8S_APP_DEPLOY=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  enable_k8s_app_deploy="${enable_k8s_app_deploy,,}"
  if [ -z "$enable_k8s_app_deploy" ]; then
    enable_k8s_app_deploy="false"
  fi
  [ "$enable_k8s_app_deploy" = "true" ]
}

install_helm_if_missing() {
  if command -v helm >/dev/null 2>&1; then
    return
  fi

  log "Helm not found, installing Helm"
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
}

K3S_KUBECONFIG="/etc/rancher/k3s/k3s.yaml"

ensure_k3s_service_running() {
  if ! command -v systemctl >/dev/null 2>&1; then
    return
  fi
  if systemctl list-unit-files | grep -q '^k3s\.service'; then
    if ! sudo systemctl is-active --quiet k3s; then
      log "Starting k3s service"
      sudo systemctl start k3s
    fi
  fi
}

set_kubeconfig_from_k3s_if_present() {
  if [ -f "$K3S_KUBECONFIG" ]; then
    export KUBECONFIG="$K3S_KUBECONFIG"
  fi
}

install_k3s_if_needed() {
  local enable_k3s_auto_install

  enable_k3s_auto_install="$(grep -E '^ENABLE_K3S_AUTO_INSTALL=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  enable_k3s_auto_install="${enable_k3s_auto_install,,}"
  if [ -z "$enable_k3s_auto_install" ]; then
    enable_k3s_auto_install="true"
  fi

  if [ "$enable_k3s_auto_install" != "true" ]; then
    log "k3s auto-install is disabled by ENABLE_K3S_AUTO_INSTALL=$enable_k3s_auto_install"
    return 1
  fi

  if command -v kubectl >/dev/null 2>&1 && kubectl get nodes >/dev/null 2>&1; then
    return 0
  fi

  log "Installing k3s (kubectl context was unavailable)"
  curl -sfL https://get.k3s.io | sh -

  ensure_k3s_service_running
  set_kubeconfig_from_k3s_if_present

  return 0
}

is_k8s_ready() {
  local cfg
  set_kubeconfig_from_k3s_if_present
  ensure_k3s_service_running

  if ! command -v kubectl >/dev/null 2>&1; then
    return 1
  fi

  if kubectl get nodes >/dev/null 2>&1; then
    return 0
  fi

  for cfg in "$K3S_KUBECONFIG" "$HOME/.kube/config"; do
    if [ -f "$cfg" ] && KUBECONFIG="$cfg" kubectl get nodes >/dev/null 2>&1; then
      export KUBECONFIG="$cfg"
      return 0
    fi
  done

  return 1
}

ensure_k8s_ready() {
  local i

  if is_k8s_ready; then
    return 0
  fi

  if ! install_k3s_if_needed; then
    return 1
  fi

  for i in $(seq 1 90); do
    if kubectl get nodes >/dev/null 2>&1 && kubectl get nodes --no-headers 2>/dev/null | grep -q " Ready"; then
      return 0
    fi
    sleep 2
  done

  return 1
}

disable_k3s_traefik() {
  local k3s_cfg="/etc/rancher/k3s/config.yaml"
  local i

  if ! ensure_k8s_ready; then
    log "Kubernetes is not ready, skipping k3s Traefik disable step"
    return 1
  fi

  sudo mkdir -p /etc/rancher/k3s
  if [ ! -f "$k3s_cfg" ]; then
    sudo tee "$k3s_cfg" >/dev/null <<EOF
disable:
  - traefik
EOF
  elif ! grep -Eq '^[[:space:]]*-[[:space:]]*traefik[[:space:]]*$' "$k3s_cfg"; then
    if grep -Eq '^[[:space:]]*disable:[[:space:]]*$' "$k3s_cfg"; then
      echo "  - traefik" | sudo tee -a "$k3s_cfg" >/dev/null
    else
      sudo tee -a "$k3s_cfg" >/dev/null <<EOF

disable:
  - traefik
EOF
    fi
  fi

  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files | grep -q '^k3s\.service'; then
    log "Restarting k3s to enforce Traefik disable"
    sudo systemctl restart k3s
  fi

  set_kubeconfig_from_k3s_if_present
  for i in $(seq 1 90); do
    if kubectl get nodes >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  kubectl -n kube-system delete helmchart traefik --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n kube-system delete helmchart traefik-crd --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n kube-system get ds -o name 2>/dev/null | grep 'svclb-traefik' | xargs -r kubectl -n kube-system delete >/dev/null 2>&1 || true
  kubectl -n kube-system get pods -o name 2>/dev/null | grep 'svclb-traefik' | xargs -r kubectl -n kube-system delete >/dev/null 2>&1 || true
  kubectl -n kube-system delete svc traefik --ignore-not-found >/dev/null 2>&1 || true

  log "k3s Traefik disable step completed"
  return 0
}

deploy_k8s_app_for_monitoring_if_enabled() {
  local kubeconfig_path
  local k8s_backend_image
  local k8s_frontend_image
  local k8s_pull_secret
  local k8s_registry
  local k8s_pull_user
  local k8s_pull_password
  kubeconfig_path="${KUBECONFIG:-$K3S_KUBECONFIG}"

  if ! is_monitoring_enabled; then
    return 0
  fi

  if ! is_k8s_app_deploy_enabled; then
    log "K8s app deploy is disabled (ENABLE_K8S_APP_DEPLOY=false). Monitoring dashboards for app metrics may stay empty."
    return 0
  fi

  if ! ensure_k8s_ready; then
    err "Kubernetes is not ready, cannot deploy app manifests for monitoring"
    return 1
  fi

  k8s_backend_image="$(grep -E '^K8S_BACKEND_IMAGE=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  k8s_frontend_image="$(grep -E '^K8S_FRONTEND_IMAGE=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  k8s_pull_secret="$(grep -E '^K8S_IMAGE_PULL_SECRET=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  k8s_registry="$(grep -E '^K8S_IMAGE_REGISTRY=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  k8s_pull_user="$(grep -E '^K8S_IMAGE_PULL_SECRET_USERNAME=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  k8s_pull_password="$(grep -E '^K8S_IMAGE_PULL_SECRET_PASSWORD=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"

  if [ -z "$k8s_backend_image" ] || [ -z "$k8s_frontend_image" ]; then
    err "K8S_BACKEND_IMAGE and K8S_FRONTEND_IMAGE must be set in .env.prod when ENABLE_K8S_APP_DEPLOY=true"
    return 1
  fi

  if [ -z "$k8s_registry" ]; then
    k8s_registry="ghcr.io"
  fi

  log "Deploying Kubernetes app manifests (ENABLE_K8S_APP_DEPLOY=true)"
  KUBECONFIG="$kubeconfig_path" kubectl apply -k "$APP_DIR/k8s"

  log "Applying k8s app images from .env.prod"
  KUBECONFIG="$kubeconfig_path" kubectl -n remnawave set image deploy/backend backend="$k8s_backend_image"
  KUBECONFIG="$kubeconfig_path" kubectl -n remnawave set image deploy/frontend frontend="$k8s_frontend_image"

  if [ -n "$k8s_pull_secret" ]; then
    if [ -n "$k8s_pull_user" ] && [ -n "$k8s_pull_password" ]; then
      log "Syncing imagePullSecret $k8s_pull_secret from .env.prod credentials"
      KUBECONFIG="$kubeconfig_path" kubectl -n remnawave create secret docker-registry "$k8s_pull_secret" \
        --docker-server="$k8s_registry" \
        --docker-username="$k8s_pull_user" \
        --docker-password="$k8s_pull_password" \
        --dry-run=client -o yaml | KUBECONFIG="$kubeconfig_path" kubectl apply -f -
    else
      log "Using existing imagePullSecret $k8s_pull_secret (credentials not provided in .env.prod)"
    fi

    KUBECONFIG="$kubeconfig_path" kubectl -n remnawave patch deploy backend --type merge \
      -p "{\"spec\":{\"template\":{\"spec\":{\"imagePullSecrets\":[{\"name\":\"$k8s_pull_secret\"}]}}}}"
    KUBECONFIG="$kubeconfig_path" kubectl -n remnawave patch deploy frontend --type merge \
      -p "{\"spec\":{\"template\":{\"spec\":{\"imagePullSecrets\":[{\"name\":\"$k8s_pull_secret\"}]}}}}"
  fi

  if [ -f "$APP_DIR/k8s/backend-secret.yaml" ]; then
    log "Applying custom k8s/backend-secret.yaml"
    KUBECONFIG="$kubeconfig_path" kubectl apply -f "$APP_DIR/k8s/backend-secret.yaml"
  fi

  log "Syncing k8s Secret/backend-secret from .env.prod"
  if ! KUBECONFIG="$kubeconfig_path" kubectl -n remnawave create secret generic backend-secret \
    --from-env-file="$APP_DIR/.env.prod" \
    --dry-run=client -o yaml | KUBECONFIG="$kubeconfig_path" kubectl apply -f -; then
    err "Failed to sync backend-secret from .env.prod"
    return 1
  fi

  if [ -f "$APP_DIR/k8s/backend-configmap.prod.yaml" ]; then
    KUBECONFIG="$kubeconfig_path" kubectl apply -f "$APP_DIR/k8s/backend-configmap.prod.yaml"
  fi

  if [ -f "$APP_DIR/k8s/ingress.prod.yaml" ]; then
    KUBECONFIG="$kubeconfig_path" kubectl apply -f "$APP_DIR/k8s/ingress.prod.yaml"
  fi
}

validate_monitoring_app_target() {
  local kubeconfig_path
  kubeconfig_path="${KUBECONFIG:-$K3S_KUBECONFIG}"

  if ! KUBECONFIG="$kubeconfig_path" kubectl get ns remnawave >/dev/null 2>&1; then
    err "Namespace remnawave not found in k8s. Prometheus cannot scrape backend app metrics."
    return
  fi

  if ! KUBECONFIG="$kubeconfig_path" kubectl -n remnawave get svc backend >/dev/null 2>&1; then
    err "Service remnawave/backend not found in k8s. Prometheus cannot scrape backend app metrics."
    return
  fi

  log "Monitoring target check passed: remnawave/backend service exists"
}

install_monitoring_stack() {
  local render_script
  local values_file

  if ! is_monitoring_enabled; then
    log "Monitoring installation disabled by ENABLE_MONITORING"
    return
  fi

  if ! ensure_k8s_ready; then
    log "Kubernetes is not ready and could not be auto-prepared, skipping Grafana/Prometheus install"
    return
  fi

  set_kubeconfig_from_k3s_if_present
  install_helm_if_missing

  render_script="$APP_DIR/scripts/render-monitoring-values.sh"
  values_file="$APP_DIR/k8s/monitoring/values.prod.yaml"
  local kubeconfig_path
  kubeconfig_path="${KUBECONFIG:-$K3S_KUBECONFIG}"

  if [ ! -f "$render_script" ]; then
    err "Missing render script: $render_script"
    return
  fi

  log "Rendering monitoring values from .env.prod"
  bash "$render_script" "$APP_DIR/.env.prod" "$values_file"

  log "Installing/Updating kube-prometheus-stack (Grafana + Prometheus)"
  KUBECONFIG="$kubeconfig_path" helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
  KUBECONFIG="$kubeconfig_path" helm repo update
  KUBECONFIG="$kubeconfig_path" helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
    --namespace monitoring --create-namespace \
    -f "$values_file"

  log "Applying project monitoring resources"
  KUBECONFIG="$kubeconfig_path" kubectl apply -k "$APP_DIR/k8s/monitoring"

  validate_monitoring_app_target
  log "Monitoring stack is installed"
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
  normalize_env_file() {
    local file="$1"
    local tmp_file
    tmp_file="$(mktemp)"
    awk '{ sub(/\r$/, ""); print }' "$file" > "$tmp_file"
    mv "$tmp_file" "$file"
  }

  dedupe_env_file_keep_last() {
    local file="$1"
    local tmp_file
    tmp_file="$(mktemp)"
    awk '
      {
        line=$0
        sub(/\r$/, "", line)
      }
      line ~ /^[[:space:]]*#/ || line ~ /^[[:space:]]*$/ {
        next
      }
      {
        pos=index(line, "=")
        if (pos == 0) {
          next
        }
        key=substr(line, 1, pos-1)
        val=substr(line, pos+1)
        gsub(/^[[:space:]]+|[[:space:]]+$/, "", key)
        if (key !~ /^[A-Za-z_][A-Za-z0-9_]*$/) {
          next
        }
        if (!(key in seen)) {
          order[++n]=key
        }
        seen[key]=1
        values[key]=val
      }
      END {
        for (i=1; i<=n; i++) {
          k=order[i]
          if (seen[k]) {
            print k "=" values[k]
          }
        }
      }
    ' "$file" > "$tmp_file"
    mv "$tmp_file" "$file"
  }

  set_env_kv() {
    local file="$1"
    local key="$2"
    local value="$3"
    local tmp_file
    tmp_file="$(mktemp)"
    awk -v k="$key" -v v="$value" '
      BEGIN { updated=0 }
      index($0, k "=") == 1 {
        if (!updated) {
          print k "=" v
          updated=1
        }
        next
      }
      { print }
      END {
        if (!updated) {
          print k "=" v
        }
      }
    ' "$file" > "$tmp_file"
    mv "$tmp_file" "$file"
  }

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

  # Normalize line endings if env was edited on Windows (CRLF -> LF).
  normalize_env_file "$APP_DIR/.env.prod"
  # Remove duplicated keys (last value wins) to avoid kubectl --from-env-file failures.
  dedupe_env_file_keep_last "$APP_DIR/.env.prod"

  local db_url
  local ssl_require
  local db_password
  local grafana_password
  local enable_https_raw
  db_url="$(grep -E '^DATABASE_URL=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  ssl_require="$(grep -E '^DJANGO_DB_SSL_REQUIRE=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  enable_https_raw="$(grep -E '^ENABLE_HTTPS=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  enable_https_raw="${enable_https_raw,,}"
  db_password=""

  if [[ "$db_url" =~ ^postgres(ql)?://[^:]+:([^@]+)@ ]]; then
    db_password="${BASH_REMATCH[2]}"
  fi

  if [ -n "$db_password" ]; then
    set_env_kv "$APP_DIR/.env.prod" "POSTGRES_PASSWORD" "$db_password"
    log "Synchronized POSTGRES_PASSWORD with DATABASE_URL"
  fi

  grafana_password="$(grep -E '^GRAFANA_ADMIN_PASSWORD=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  if [ -z "$grafana_password" ] && [ -n "$db_password" ]; then
    echo "GRAFANA_ADMIN_PASSWORD=$db_password" >> "$APP_DIR/.env.prod"
    log "Set GRAFANA_ADMIN_PASSWORD from POSTGRES_PASSWORD"
  fi

  if [[ "$db_url" == *"@postgres:"* || "$db_url" == *"@remnawave-blue-postgres-1:"* || "$db_url" == *"@remnawave-green-postgres-1:"* ]]; then
    local db_url_shared
    db_url_shared="$db_url"
    db_url_shared="${db_url_shared//@postgres:/@remnawave-shared-postgres:}"
    db_url_shared="${db_url_shared//@remnawave-blue-postgres-1:/@remnawave-shared-postgres:}"
    db_url_shared="${db_url_shared//@remnawave-green-postgres-1:/@remnawave-shared-postgres:}"
    set_env_kv "$APP_DIR/.env.prod" "DATABASE_URL" "$db_url_shared"
    db_url="$db_url_shared"
    log "Updated DATABASE_URL to shared postgres host"
  fi

  if [[ "$db_url" == *"@postgres:"* || "$db_url" == *"@remnawave-shared-postgres:"* ]] && [[ "${ssl_require,,}" != "false" ]]; then
    set_env_kv "$APP_DIR/.env.prod" "DJANGO_DB_SSL_REQUIRE" "False"
    log "Set DJANGO_DB_SSL_REQUIRE=False for local docker postgres"
  fi

  if [ "$enable_https_raw" = "true" ]; then
    set_env_kv "$APP_DIR/.env.prod" "DJANGO_SECURE_SSL_REDIRECT" "True"
    set_env_kv "$APP_DIR/.env.prod" "DJANGO_SESSION_COOKIE_SECURE" "True"
    set_env_kv "$APP_DIR/.env.prod" "DJANGO_CSRF_COOKIE_SECURE" "True"
  else
    set_env_kv "$APP_DIR/.env.prod" "DJANGO_SECURE_SSL_REDIRECT" "False"
    set_env_kv "$APP_DIR/.env.prod" "DJANGO_SESSION_COOKIE_SECURE" "False"
    set_env_kv "$APP_DIR/.env.prod" "DJANGO_CSRF_COOKIE_SECURE" "False"
  fi

  cp "$APP_DIR/.env.prod" "$APP_DIR/backend/.env"
  log "Updated backend/.env from .env.prod"
}

ensure_shared_network() {
  if ! docker network inspect "$SHARED_NETWORK" >/dev/null 2>&1; then
    log "Creating shared docker network: $SHARED_NETWORK"
    docker network create "$SHARED_NETWORK" >/dev/null
  fi
}

find_source_postgres_container() {
  local candidates=()
  if [ "$ACTIVE_COLOR" = "blue" ] || [ "$ACTIVE_COLOR" = "green" ]; then
    candidates+=("remnawave-${ACTIVE_COLOR}-postgres-1")
  fi
  candidates+=("remnawave-blue-postgres-1" "remnawave-green-postgres-1")

  local candidate
  for candidate in "${candidates[@]}"; do
    if docker ps --format '{{.Names}}' | grep -qx "$candidate"; then
      echo "$candidate"
      return 0
    fi
  done

  return 1
}

shared_db_tables_count() {
  docker exec "$SHARED_DB_CONTAINER" psql -U postgres -d remnawave -tAc \
    "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE';" | tr -d '[:space:]'
}

seed_shared_db_if_empty() {
  local table_count
  table_count="$(shared_db_tables_count || echo "")"
  if [ -n "$table_count" ] && [ "$table_count" != "0" ]; then
    log "Shared postgres already has data, seed is not required"
    return
  fi

  local source_container
  if ! source_container="$(find_source_postgres_container)"; then
    log "Source color postgres not found, skipping initial DB seed"
    return
  fi

  log "Seeding shared postgres from ${source_container}"
  docker exec "$source_container" pg_dump -U postgres -d remnawave --clean --if-exists --no-owner --no-privileges \
    | docker exec -i "$SHARED_DB_CONTAINER" psql -U postgres -d remnawave >/dev/null
  log "Shared postgres seed completed"
}

ensure_shared_db() {
  ensure_shared_network
  log "Starting shared postgres"
  compose_shared_db up -d postgres

  local i
  for i in $(seq 1 60); do
    if docker exec "$SHARED_DB_CONTAINER" pg_isready -U postgres -d remnawave >/dev/null 2>&1; then
      seed_shared_db_if_empty
      return
    fi
    sleep 2
  done

  err "Shared postgres is not ready"
  compose_shared_db ps || true
  compose_shared_db logs postgres --tail 120 || true
  exit 1
}

read_domain_from_env() {
  DOMAIN="$(grep -E '^NGINX_SERVER_NAME=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  if [ -z "$DOMAIN" ]; then
    err "NGINX_SERVER_NAME is empty in $APP_DIR/.env.prod"
    exit 1
  fi
  ENABLE_HTTPS="$(grep -E '^ENABLE_HTTPS=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  LETSENCRYPT_EMAIL="$(grep -E '^LETSENCRYPT_EMAIL=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  GRAFANA_NODEPORT="$(grep -E '^GRAFANA_NODEPORT=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  GRAFANA_SUBPATH="$(grep -E '^GRAFANA_SUBPATH=' "$APP_DIR/.env.prod" | tail -n1 | cut -d '=' -f2- | tr -d '\r' || true)"
  if [ -z "$GRAFANA_NODEPORT" ]; then
    GRAFANA_NODEPORT="32000"
  fi
  if [ -z "$GRAFANA_SUBPATH" ]; then
    GRAFANA_SUBPATH="/dashboard"
  fi
  ENABLE_HTTPS="${ENABLE_HTTPS,,}"
  if [ -z "$ENABLE_HTTPS" ]; then
    ENABLE_HTTPS="false"
  fi
  if [[ "$GRAFANA_SUBPATH" != /* ]]; then
    GRAFANA_SUBPATH="/$GRAFANA_SUBPATH"
  fi
  GRAFANA_SUBPATH="${GRAFANA_SUBPATH%/}"
  if [ -z "$GRAFANA_SUBPATH" ]; then
    GRAFANA_SUBPATH="/dashboard"
  fi
  export DOMAIN
  export GRAFANA_NODEPORT
  export GRAFANA_SUBPATH
  export ENABLE_HTTPS
  export LETSENCRYPT_EMAIL
}

get_active_color() {
  if [ -f "$ACTIVE_FILE" ]; then
    ACTIVE_COLOR="$(cat "$ACTIVE_FILE")"
  else
    ACTIVE_COLOR=""
  fi
}

set_target_color() {
  local requested="${1:-}"

  if [ "$requested" = "blue" ]; then
    TARGET_COLOR="blue"
    TARGET_BACKEND_PORT=$BLUE_BACKEND_PORT
    TARGET_FRONTEND_PORT=$BLUE_FRONTEND_PORT
    OLD_COLOR="green"
    OLD_BACKEND_PORT=$GREEN_BACKEND_PORT
    OLD_FRONTEND_PORT=$GREEN_FRONTEND_PORT
  elif [ "$requested" = "green" ]; then
    TARGET_COLOR="green"
    TARGET_BACKEND_PORT=$GREEN_BACKEND_PORT
    TARGET_FRONTEND_PORT=$GREEN_FRONTEND_PORT
    OLD_COLOR="blue"
    OLD_BACKEND_PORT=$BLUE_BACKEND_PORT
    OLD_FRONTEND_PORT=$BLUE_FRONTEND_PORT
  elif [ "$ACTIVE_COLOR" = "blue" ]; then
    TARGET_COLOR="green"
    TARGET_BACKEND_PORT=$GREEN_BACKEND_PORT
    TARGET_FRONTEND_PORT=$GREEN_FRONTEND_PORT
    OLD_COLOR="blue"
    OLD_BACKEND_PORT=$BLUE_BACKEND_PORT
    OLD_FRONTEND_PORT=$BLUE_FRONTEND_PORT
  elif [ "$ACTIVE_COLOR" = "green" ]; then
    TARGET_COLOR="blue"
    TARGET_BACKEND_PORT=$BLUE_BACKEND_PORT
    TARGET_FRONTEND_PORT=$BLUE_FRONTEND_PORT
    OLD_COLOR="green"
    OLD_BACKEND_PORT=$GREEN_BACKEND_PORT
    OLD_FRONTEND_PORT=$GREEN_FRONTEND_PORT
  else
    TARGET_COLOR="blue"
    TARGET_BACKEND_PORT=$BLUE_BACKEND_PORT
    TARGET_FRONTEND_PORT=$BLUE_FRONTEND_PORT
    OLD_COLOR="green"
    OLD_BACKEND_PORT=$GREEN_BACKEND_PORT
    OLD_FRONTEND_PORT=$GREEN_FRONTEND_PORT
  fi

  export TARGET_COLOR TARGET_BACKEND_PORT TARGET_FRONTEND_PORT OLD_COLOR OLD_BACKEND_PORT OLD_FRONTEND_PORT
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
  log "Shared postgres logs:"
  compose_shared_db logs postgres --tail 80 || true
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
    log "Detected postgres password mismatch; recreating shared postgres volume and retrying once"
    compose_shared_db down -v || true
    RETRIED_DB_RESET=1
    ensure_shared_db
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
  if ! wait_http "http://127.0.0.1:${TARGET_BACKEND_PORT}/api/health/" "$DOMAIN" 90; then
    if maybe_recover_db_password_mismatch; then
      log "Retrying backend health check after DB reset"
      if wait_http "http://127.0.0.1:${TARGET_BACKEND_PORT}/api/health/" "$DOMAIN" 120; then
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
    client_max_body_size 15m;

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

    location = ${GRAFANA_SUBPATH} {
        return 301 ${GRAFANA_SUBPATH}/;
    }

    location ${GRAFANA_SUBPATH}/ {
        proxy_pass http://127.0.0.1:${GRAFANA_NODEPORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
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
    client_max_body_size 15m;

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
    client_max_body_size 15m;

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

    location = ${GRAFANA_SUBPATH} {
        return 301 ${GRAFANA_SUBPATH}/;
    }

    location ${GRAFANA_SUBPATH}/ {
        proxy_pass http://127.0.0.1:${GRAFANA_NODEPORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
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
  if sudo systemctl is-active --quiet nginx; then
    sudo systemctl reload nginx
  else
    log "nginx is not active, starting nginx service"
    sudo systemctl start nginx
  fi
}

obtain_letsencrypt_cert_for_domain() {
  local domain="$1"
  if [ "$ENABLE_HTTPS" != "true" ]; then
    log "HTTPS disabled (ENABLE_HTTPS=$ENABLE_HTTPS)"
    return
  fi

  if [ -z "$LETSENCRYPT_EMAIL" ]; then
    err "ENABLE_HTTPS=true but LETSENCRYPT_EMAIL is empty"
    return
  fi

  sudo mkdir -p "$CERTBOT_WEBROOT/.well-known/acme-challenge"
  if [ -f "/etc/letsencrypt/live/${domain}/fullchain.pem" ] && [ -f "/etc/letsencrypt/live/${domain}/privkey.pem" ]; then
    log "Let's Encrypt certificate already exists for ${domain}"
    return
  fi

  log "Requesting Let's Encrypt certificate for ${domain}"
  sudo certbot certonly --webroot -w "$CERTBOT_WEBROOT" \
    -d "$domain" \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos --non-interactive --keep-until-expiring
}

has_letsencrypt_cert_for_domain() {
  local domain="$1"
  [ -f "/etc/letsencrypt/live/${domain}/fullchain.pem" ] && [ -f "/etc/letsencrypt/live/${domain}/privkey.pem" ]
}

switch_nginx() {
  write_nginx_http_config
  reload_nginx_with_site
  obtain_letsencrypt_cert_for_domain "$DOMAIN"
  if [ "$ENABLE_HTTPS" = "true" ] && has_letsencrypt_cert_for_domain "$DOMAIN"; then
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

print_color_status() {
  local color="$1"
  local backend_port="$2"
  local frontend_port="$3"
  log "Stack status (${color}):"
  compose_for_color "${color}" "${backend_port}" "${frontend_port}" ps || true
}

summary() {
  log "Done. Active color: ${TARGET_COLOR}"
  print_color_status "${TARGET_COLOR}" "${TARGET_BACKEND_PORT}" "${TARGET_FRONTEND_PORT}"
  print_color_status "${OLD_COLOR}" "${OLD_BACKEND_PORT}" "${OLD_FRONTEND_PORT}"
}

site_installed() {
  [ -d "$APP_DIR/.git" ] && [ -f "$COMPOSE_FILE" ]
}

remove_all_changes() {
  if ! site_installed; then
    err "Project is not installed: nothing to remove"
    return
  fi

  log "Stopping and removing blue/green stacks"
  compose_for_color "blue" "$BLUE_BACKEND_PORT" "$BLUE_FRONTEND_PORT" down -v || true
  compose_for_color "green" "$GREEN_BACKEND_PORT" "$GREEN_FRONTEND_PORT" down -v || true
  compose_shared_db down -v || true
  docker network rm "$SHARED_NETWORK" >/dev/null 2>&1 || true

  log "Removing nginx remnawave site"
  sudo rm -f /etc/nginx/sites-enabled/remnawave
  sudo rm -f /etc/nginx/sites-available/remnawave
  sudo nginx -t && sudo systemctl reload nginx || true

  log "Removing project directory: $APP_DIR"
  sudo rm -rf "$APP_DIR"

  log "Cleanup complete"
}

run_deploy_flow() {
  local requested_color="${1:-}"
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
  if is_monitoring_enabled; then
    disable_k3s_traefik || true
    deploy_k8s_app_for_monitoring_if_enabled || true
  fi
  get_active_color
  ensure_shared_db
  set_target_color "$requested_color"
  deploy_color "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT"
  health_check_target
  switch_nginx
  install_monitoring_stack
  log "Keeping ${OLD_COLOR} stack running for fast rollback"
  summary
}

color_stack_exists() {
  local color="$1"
  local backend_port="$2"
  local frontend_port="$3"
  local backend_id
  local frontend_id

  backend_id="$(compose_for_color "$color" "$backend_port" "$frontend_port" ps -q backend 2>/dev/null || true)"
  frontend_id="$(compose_for_color "$color" "$backend_port" "$frontend_port" ps -q frontend 2>/dev/null || true)"

  [ -n "$backend_id" ] && [ -n "$frontend_id" ]
}

switch_existing_flow() {
  local requested_color="$1"
  require_sudo
  prepare_repo

  if [ ! -f "$COMPOSE_FILE" ]; then
    err "Missing $COMPOSE_FILE"
    exit 1
  fi

  prepare_env_files
  read_domain_from_env
  get_active_color
  ensure_shared_db
  set_target_color "$requested_color"

  if [ "$ACTIVE_COLOR" = "$TARGET_COLOR" ]; then
    log "Color ${TARGET_COLOR} is already active"
    summary
    return
  fi

  if ! color_stack_exists "$TARGET_COLOR" "$TARGET_BACKEND_PORT" "$TARGET_FRONTEND_PORT"; then
    err "Rollback target '${TARGET_COLOR}' is not deployed. Deploy it first via menu item 1."
    exit 1
  fi

  log "Rollback switch: ${ACTIVE_COLOR:-none} -> ${TARGET_COLOR}"
  health_check_target
  switch_nginx
  log "Stopping previous active color after rollback: ${OLD_COLOR}"
  compose_for_color "${OLD_COLOR}" "${OLD_BACKEND_PORT}" "${OLD_FRONTEND_PORT}" down || true
  summary
}

confirm_action() {
  local prompt="$1"
  local answer=""
  while true; do
    menu_print "${COLOR_YELLOW}${prompt}${COLOR_RESET}"
    menu_item "1" "Да"
    menu_item "2" "Нет"
    if ! menu_read "> " answer; then
      err "Не удалось прочитать подтверждение"
      return 1
    fi
    case "$answer" in
      1) return 0 ;;
      2) return 1 ;;
      *) menu_print "${COLOR_YELLOW}Введите 1 или 2.${COLOR_RESET}" ;;
    esac
  done
}

print_menu() {
  local active=""
  local rollback_target=""
  local rollback_label=""
  local install_hint=""

  if [ -f "$ACTIVE_FILE" ]; then
    active="$(cat "$ACTIVE_FILE" 2>/dev/null || true)"
  fi

  if [ "$active" = "blue" ]; then
    install_hint=" (установит обновление на green)"
    rollback_target="green"
  elif [ "$active" = "green" ]; then
    install_hint=" (установит обновление на blue)"
    rollback_target="blue"
  else
    install_hint=" (установит обновление на blue)"
    rollback_target=""
  fi

  menu_print ""
  if [ "$active" = "blue" ] || [ "$active" = "green" ]; then
    menu_print "${COLOR_YELLOW}Сайт развёрнут на ${active}${COLOR_RESET}"
  else
    menu_print "${COLOR_YELLOW}Сайт ещё не развёрнут${COLOR_RESET}"
  fi
  if [ "$UPDATE_AVAILABLE" -eq 1 ]; then
    menu_print "${COLOR_YELLOW}Есть обновление!${COLOR_RESET}"
  fi
  menu_print "${COLOR_YELLOW}Выберите действие:${COLOR_RESET}"
  menu_item "1" "Установка сайта${install_hint}"

  if [ -n "$rollback_target" ]; then
    rollback_label="Откат изменений (${rollback_target})"
  else
    rollback_label="Откат изменений (недоступно)"
  fi
  menu_item "2" "${rollback_label}"
  menu_item "3" "Удалить изменения"
  if [ "$UPDATE_AVAILABLE" -eq 1 ]; then
    menu_item "4" "Обновить скрипт"
  fi
  menu_print ""
  menu_item "0" "Выход из скрипта"
}

main() {
  auto_refresh_script "$@"
  setup_interactive_tty
  while true; do
    check_script_update
    print_menu
    if ! menu_read "> " choice; then
      err "Не удалось прочитать выбор пункта меню"
      continue
    fi

    case "$choice" in
      1)
        if confirm_action "Запустить установку сайта?"; then
          run_deploy_flow ""
        else
          log "Операция отменена"
        fi
        ;;
      2)
        if site_installed; then
          get_active_color
          if [ "$ACTIVE_COLOR" = "blue" ]; then
            if color_stack_exists "green" "$GREEN_BACKEND_PORT" "$GREEN_FRONTEND_PORT"; then
              if confirm_action "Переключить трафик на green (rollback)?"; then
                switch_existing_flow "green"
              else
                log "Операция отменена"
              fi
            else
              err "green не развернут"
            fi
          elif [ "$ACTIVE_COLOR" = "green" ]; then
            if color_stack_exists "blue" "$BLUE_BACKEND_PORT" "$BLUE_FRONTEND_PORT"; then
              if confirm_action "Переключить трафик на blue (rollback)?"; then
                switch_existing_flow "blue"
              else
                log "Операция отменена"
              fi
            else
              err "blue не развернут"
            fi
          else
            err "Нет активного цвета для отката"
          fi
        else
          err "Сайт не установлен"
        fi
        ;;
      3)
        if site_installed; then
          if confirm_action "Удалить все изменения проекта?"; then
            remove_all_changes
          else
            log "Операция отменена"
          fi
        else
          err "Сайт не установлен"
        fi
        ;;
      0)
        if confirm_action "Выйти из скрипта?"; then
          log "Выход"
          exit 0
        fi
        ;;
      4)
        if [ "$UPDATE_AVAILABLE" -eq 1 ]; then
          if confirm_action "Обновить скрипт сейчас?"; then
            update_script_now
          else
            log "Операция отменена"
          fi
        else
          err "Обновление не найдено"
        fi
        ;;
      *)
        err "Неизвестный пункт меню"
        ;;
    esac
  done
}

main "$@"
