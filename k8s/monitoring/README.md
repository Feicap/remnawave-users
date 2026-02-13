# Monitoring stack (Prometheus + Grafana)

Install `kube-prometheus-stack`:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f k8s/monitoring/values.prod.yaml
```

Notes:
- Keep `k8s/monitoring/values.yaml` generic (placeholders only).
- Put real domain/password in local `k8s/monitoring/values.prod.yaml` (gitignored).
- This stack monitors cluster-level metrics out of the box.
- Application-level metrics require adding `/metrics` endpoint in backend (for example via `django-prometheus`).
