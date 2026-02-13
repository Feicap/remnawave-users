#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${1:-$ROOT_DIR/.env.prod}"
OUT_FILE="${2:-$ROOT_DIR/k8s/monitoring/values.prod.yaml}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[ERROR] Env file not found: $ENV_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

GRAFANA_DOMAIN="${GRAFANA_DOMAIN:-${NGINX_SERVER_NAME:-}}"
GRAFANA_ADMIN_PASSWORD="${GRAFANA_ADMIN_PASSWORD:-${POSTGRES_PASSWORD:-}}"
GRAFANA_NODEPORT="${GRAFANA_NODEPORT:-32000}"
GRAFANA_SUBPATH="${GRAFANA_SUBPATH:-/dashboard}"
PROMETHEUS_RETENTION="${PROMETHEUS_RETENTION:-15d}"
PROMETHEUS_STORAGE_SIZE="${PROMETHEUS_STORAGE_SIZE:-20Gi}"
GRAFANA_STORAGE_SIZE="${GRAFANA_STORAGE_SIZE:-5Gi}"

if [ -z "$GRAFANA_DOMAIN" ]; then
  echo "[ERROR] GRAFANA_DOMAIN is empty (set GRAFANA_DOMAIN or NGINX_SERVER_NAME in $ENV_FILE)" >&2
  exit 1
fi

if [ -z "$GRAFANA_ADMIN_PASSWORD" ]; then
  echo "[ERROR] GRAFANA_ADMIN_PASSWORD is empty (set it or POSTGRES_PASSWORD in $ENV_FILE)" >&2
  exit 1
fi

if [[ "$GRAFANA_SUBPATH" != /* ]]; then
  GRAFANA_SUBPATH="/$GRAFANA_SUBPATH"
fi
GRAFANA_SUBPATH="${GRAFANA_SUBPATH%/}"
if [ -z "$GRAFANA_SUBPATH" ]; then
  GRAFANA_SUBPATH="/dashboard"
fi

yaml_sq_escape() {
  printf "%s" "$1" | sed "s/'/''/g"
}

mkdir -p "$(dirname "$OUT_FILE")"
cat > "$OUT_FILE" <<EOF
grafana:
  adminPassword: '$(yaml_sq_escape "$GRAFANA_ADMIN_PASSWORD")'
  grafana.ini:
    server:
      domain: '$(yaml_sq_escape "$GRAFANA_DOMAIN")'
      root_url: 'https://$(yaml_sq_escape "$GRAFANA_DOMAIN")$(yaml_sq_escape "$GRAFANA_SUBPATH")/'
      serve_from_sub_path: true
  service:
    type: NodePort
    nodePort: $(yaml_sq_escape "$GRAFANA_NODEPORT")
  ingress:
    enabled: false
  defaultDashboardsTimezone: utc
  sidecar:
    dashboards:
      enabled: true
      label: grafana_dashboard
      searchNamespace: monitoring
  persistence:
    enabled: true
    size: '$(yaml_sq_escape "$GRAFANA_STORAGE_SIZE")'

prometheus:
  ingress:
    enabled: false
  prometheusSpec:
    retention: '$(yaml_sq_escape "$PROMETHEUS_RETENTION")'
    storageSpec:
      volumeClaimTemplate:
        spec:
          accessModes: ["ReadWriteOnce"]
          resources:
            requests:
              storage: '$(yaml_sq_escape "$PROMETHEUS_STORAGE_SIZE")'

alertmanager:
  enabled: true

kube-state-metrics:
  enabled: true

nodeExporter:
  enabled: true
EOF

echo "[OK] Rendered $OUT_FILE from $ENV_FILE"
