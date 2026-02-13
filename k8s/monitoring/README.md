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

## 2) Enable backend app scraping

Backend app metrics are exposed on `/metrics` (Django + `django-prometheus`).
Apply all monitoring resources for this repo:

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

In Prometheus UI (`Status -> Targets`), target `backend` should be `UP`.

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
   - Requests per second (RPS)
   - p95 latency
   - 5xx error rate
   - Pod restarts

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

# Pod restarts in namespace
sum(increase(kube_pod_container_status_restarts_total{namespace="remnawave"}[30m]))
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
