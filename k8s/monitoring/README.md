# Monitoring stack (Prometheus + Grafana)

## 1) Install kube-prometheus-stack

Render local prod values from `.env.prod` (gitignored):

```bash
bash scripts/render-monitoring-values.sh .env.prod k8s/monitoring/values.prod.yaml
```

PowerShell (Windows):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/render-monitoring-values.ps1 .env.prod k8s/monitoring/values.prod.yaml
```

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f k8s/monitoring/values.prod.yaml
```

## 2) Apply monitoring resources for Docker app targets

This repo now monitors Docker frontend/backend via:
- backend metrics scrape: `https://<domain>/api/metrics` (or `http://` when `ENABLE_HTTPS=false`)
- blackbox probes:
  - frontend URL `/`
  - backend health URL `/api/health/`

Apply monitoring resources:

```bash
kubectl apply -k k8s/monitoring
```

## 3) Validate ingestion in Prometheus

```bash
kubectl get pods -n monitoring
kubectl get servicemonitor -n monitoring
kubectl get prometheusrule -n monitoring
kubectl get configmap -n monitoring | grep grafana-dashboard-remnawave-backend
```

In Prometheus UI (`Status -> Targets`), targets should include:
- `remnawave-docker-backend` (metrics scrape)
- `remnawave-frontend-probe`
- `remnawave-backend-health-probe`

## 4) Open Grafana

Default in this repo: Grafana ingress is disabled, service is exposed as `NodePort`.
External access is expected via host nginx reverse proxy (configured by deploy script) on:
- `https://<NGINX_SERVER_NAME><GRAFANA_SUBPATH>` (default: `https://<domain>/dashboard`)

If ingress is not configured, use port-forward:

```bash
kubectl port-forward -n monitoring svc/monitoring-grafana 3000:80
```

Then open `http://localhost:3000`.

## 5) How to use Grafana in this repo

1. Open `Dashboards` and find `Remnawave Backend Overview`.
2. Dashboard is auto-provisioned from `k8s/monitoring/grafana-dashboard-backend.yaml`.
3. If dashboard does not appear, restart Grafana pod once:

```bash
kubectl rollout restart deploy/monitoring-grafana -n monitoring
```

4. Validate panels:
   - Backend RPS
   - Backend p95 latency
   - Backend 5xx rate
   - Frontend availability

Recommended starter queries:

```promql
# RPS by Django view (5m rate)
sum by (view) (rate(django_http_requests_total_by_view_transport_method_total[5m]))

# Total 5xx rate
sum(rate(django_http_responses_total_by_status_total{status=~"5.."}[5m]))

# p95 latency
histogram_quantile(
  0.95,
  sum by (le) (rate(django_http_requests_latency_seconds_by_view_method_bucket[5m]))
)

# Frontend availability (1.0 = up)
avg_over_time(probe_success{job="remnawave-frontend-probe"}[5m])
```

## 6) Alert rules in this repo

Defined in `k8s/monitoring/backend-prometheusrule.yaml`:
- `RemnawaveBackendHigh5xxRate`
- `RemnawaveBackendHighP95Latency`
- `RemnawaveBackendPodRestarts`
- `RemnawaveBackendPodNotReady`

## Notes

- Keep `k8s/monitoring/values.yaml` generic (placeholders only).
- Keep secrets in `.env.prod`, generate `k8s/monitoring/values.prod.yaml` via `scripts/render-monitoring-values.sh` or `scripts/render-monitoring-values.ps1`.
- Cluster metrics are available out of the box, app metrics require `/metrics` endpoint and ServiceMonitor.
