# remnawave-users

Монорепозиторий проекта:
- `backend` - Django API (Telegram auth)
- `frontend` - React + Vite
- `k8s` - манифесты Kubernetes и мониторинг (Prometheus/Grafana)

## Политика чувствительных данных
- В `example` и базовых файлах используются только плейсхолдеры (`your-domain`, `your-password`, `your-token`).
- Реальные значения хранятся только в локальных prod-файлах.
- Локальные prod-файлы добавлены в `.gitignore` и не должны попадать в Git.

## Что заполнить перед развёртыванием
Пользователь заполняет `.env` и prod-файлы вручную перед запуском.

### 1) Backend env (`backend/.env`)
```bash
cp backend/.env.example backend/.env
nano backend/.env
```

Минимально заполнить:
- `DJANGO_SECRET_KEY`
- `DJANGO_DEBUG=False`
- `DJANGO_ALLOWED_HOSTS=your-domain`
- `DJANGO_CSRF_TRUSTED_ORIGINS=https://your-domain`
- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_GROUP_CHAT_ID`
- `REMNAWAVE_BASE_URL`
- `REMNAWAVE_TOKEN`
- `REMNAWAVE_COOKIE`

### 2) Frontend env (`frontend/.env`)
```bash
cp frontend/.env.example frontend/.env
nano frontend/.env
```

Указать:
- `VITE_TELEGRAM_BOT_NAME=<имя_бота>`
- `VITE_API_URL=<домен>/api/`
/api/

### 3) Docker prod env (`.env.prod`)
```bash
cat > .env.prod <<'EOF'
DJANGO_DEBUG=False
DJANGO_DB_SSL_REQUIRE=True
DJANGO_ALLOWED_HOSTS=your-domain
DJANGO_CSRF_TRUSTED_ORIGINS=https://your-domain
DATABASE_URL=postgresql://postgres:your-db-password@postgres:5432/remnawave
NGINX_SERVER_NAME=your-domain
VITE_TELEGRAM_BOT_NAME=<имя_бота>
VITE_API_URL=<домен>/api/
VITE_GRAFANA_URL=https://grafanaz.ftp.sh
GRAFANA_DOMAIN=grafana.your-domain
# optional, default = POSTGRES_PASSWORD from DATABASE_URL
# GRAFANA_ADMIN_PASSWORD=your-grafana-password
GRAFANA_NODEPORT=32000
GRAFANA_PUBLIC_PORT=80
EOF
```

## Локальные prod-файлы (игнорируются Git)
- `backend/.env.prod`
- `k8s/ingress.prod.yaml`
- `k8s/backend-configmap.prod.yaml`
- `k8s/monitoring/values.prod.yaml`
- `k8s/backend-secret.yaml`

## Вариант 1: Docker Compose на Ubuntu VPS

### Быстрый запуск blue-green инсталлятора
```bash
curl -fsSL https://raw.githubusercontent.com/Feicap/remnawave-users/main/scripts/install-blue-green-ubuntu.sh | bash
```

Инсталлятор автоматически устанавливает Grafana/Prometheus (kube-prometheus-stack).
Если `kubectl` недоступен, он пытается установить `k3s` и продолжает установку мониторинга.
`KUBECONFIG` для k3s подхватывается автоматически (`/etc/rancher/k3s/k3s.yaml`).
Отключение: `ENABLE_MONITORING=false` в `.env.prod`.
Отключить автоустановку k3s: `ENABLE_K3S_AUTO_INSTALL=false` в `.env.prod`.

### Установка Docker + Compose plugin
```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo $VERSION_CODENAME) stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

### Клонирование и запуск
```bash
git clone https://github.com/Feicap/remnawave-users.git /opt/remnawave
cd /opt/remnawave

cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# заполните backend/.env и frontend/.env

docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

### Проверка
```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml logs -f frontend
```

## Вариант 2: Kubernetes (k3s) на Ubuntu VPS

### Установка k3s
```bash
curl -sfL https://get.k3s.io | sh -
sudo kubectl get nodes
```

### Установка Helm
```bash
curl https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
helm version
```

### Установка ingress-nginx
```bash
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
  -n ingress-nginx --create-namespace
```

### Установка cert-manager
```bash
helm repo add jetstack https://charts.jetstack.io
helm repo update
helm upgrade --install cert-manager jetstack/cert-manager \
  -n cert-manager --create-namespace \
  --set crds.enabled=true
```

### Подготовка манифестов
1. Соберите/запушьте образы и обновите теги в:
- `k8s/backend-deployment.yaml`
- `k8s/frontend-deployment.yaml`

2. Используйте локальные prod-файлы:
```bash
cp k8s/backend-secret.example.yaml k8s/backend-secret.yaml
# при необходимости создайте/обновите:
# k8s/ingress.prod.yaml
# k8s/backend-configmap.prod.yaml
# k8s/monitoring/values.prod.yaml
```

3. Применение:
```bash
kubectl apply -k k8s
kubectl apply -f k8s/backend-secret.yaml
kubectl apply -f k8s/backend-configmap.prod.yaml
kubectl apply -f k8s/ingress.prod.yaml
```

## Grafana + Prometheus
```bash
bash scripts/render-monitoring-values.sh .env.prod k8s/monitoring/values.prod.yaml
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace \
  -f k8s/monitoring/values.prod.yaml
kubectl apply -k k8s/monitoring
```

Проверка:
```bash
kubectl get pods -n monitoring
kubectl get ingress -n monitoring
kubectl get servicemonitor -n monitoring
kubectl get prometheusrule -n monitoring
```

PowerShell (Windows):
```powershell
powershell -ExecutionPolicy Bypass -File scripts/render-monitoring-values.ps1 .env.prod k8s/monitoring/values.prod.yaml
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo update
helm upgrade --install monitoring prometheus-community/kube-prometheus-stack --namespace monitoring --create-namespace -f k8s/monitoring/values.prod.yaml
kubectl apply -k k8s/monitoring
```

Подробная инструкция по использованию Grafana и рекомендуемым дашбордам:
- `k8s/monitoring/README.md`

## Безопасность
- Не коммитьте реальные `.env` и секреты.
- Для Kubernetes лучше использовать Sealed Secrets/Vault/внешний secret manager.
- Для production используйте фиксированные image tags, а не `latest`.
