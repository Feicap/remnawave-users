# remnawave-users

Monorepo with:
- `backend`: Django API for Telegram auth
- `frontend`: React + Vite application

## Requirements
- Python 3.13+
- Node.js 20+
- npm 10+
- Git 2.40+

## Quick start

### 1. Backend
```bash
cd backend
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env
python manage.py migrate
python manage.py runserver 127.0.0.1:8080
```

### 2. Frontend
```bash
cd frontend
npm ci
copy .env.example .env
npm run dev
```

Frontend dev server: `http://127.0.0.1:5173`

## Environment variables

### Backend (`backend/.env`)
- `DJANGO_SECRET_KEY`
- `DJANGO_DEBUG`
- `DJANGO_ALLOWED_HOSTS`
- `DJANGO_CSRF_TRUSTED_ORIGINS`
- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_GROUP_CHAT_ID`
- `REMNAWAVE_BASE_URL`
- `REMNAWAVE_TOKEN`
- `REMNAWAVE_COOKIE`

### Frontend (`frontend/.env`)
- `VITE_TELEGRAM_BOT_NAME`

## Release checklist
- [ ] Fill `.env` files with production values.
- [ ] Set `DJANGO_DEBUG=False`.
- [ ] Set `DJANGO_ALLOWED_HOSTS` for production domain.
- [ ] Build frontend: `npm run build`.
- [ ] Run backend checks: `python manage.py check --deploy`.
- [ ] Commit and push to GitHub.

## Docker (local)

`docker-compose.yml` is for local/dev run (it can enable dev-friendly backend flags).
For release use Kubernetes manifests and set strict production env values (`DJANGO_DEBUG=False`).

`frontend` build now reads `frontend/.env` (`VITE_*`), and `build.args` can override these values.

1. Prepare backend env:
```bash
cd backend
copy .env.example .env
```

2. Build and run:
```bash
cd ..
docker compose up -d --build
```

3. Open:
- Frontend: `http://127.0.0.1`
- Backend: `http://127.0.0.1:8080`

## VPS from GitHub (runtime secrets)

1. Clone repository on VPS:
```bash
git clone <repo_url> /opt/remnawave
cd /opt/remnawave
```

2. Create runtime env files on VPS (do not commit them):
```bash
cp .env.prod.example .env.prod
cp backend/.env.example backend/.env
```

3. Fill real secrets in `backend/.env` and set domain in `.env.prod`:
- `NGINX_SERVER_NAME=jobrhyme.raspberryip.com`
- `DJANGO_ALLOWED_HOSTS=jobrhyme.raspberryip.com`
- `DJANGO_CSRF_TRUSTED_ORIGINS=https://jobrhyme.raspberryip.com`

4. Start production compose:
```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

5. On updates:
```bash
git pull
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --build
```

Notes:
- Secrets stay only on VPS in `.env` files.
- `frontend` nginx uses runtime variable `NGINX_SERVER_NAME`.
- `docker-compose.prod.yml` binds to `127.0.0.1`; expose domain outside via host nginx reverse proxy.

## Kubernetes (base manifests)

Manifest directory: `k8s/`

Before deploy:
- Build/push images and set them in:
  - `k8s/backend-deployment.yaml`
  - `k8s/frontend-deployment.yaml`
- Copy secret template and fill real values:
  - `k8s/backend-secret.example.yaml` -> `k8s/backend-secret.yaml`
- Replace domain in:
  - `k8s/ingress.yaml`

Apply:
```bash
kubectl apply -f k8s/backend-secret.yaml
kubectl apply -k k8s
```

Optional autoscaling is already included in `k8s/hpa.yaml`.

## Grafana / Prometheus

Helm values are in `k8s/monitoring/values.yaml`.
Install instructions: `k8s/monitoring/README.md`.

## Important production notes

- Do not store `.env` in GitHub (`backend/.env` and `frontend/.env` are ignored).
- For Kubernetes, keep secrets in Secret manager/Sealed Secrets/Vault.
- SQLite is not recommended in cluster mode; use PostgreSQL via `DATABASE_URL`.
- Ensure `DJANGO_DEBUG=False` in production secrets/config.

## GitHub setup
After local git initialization, create empty repo on GitHub and run:

```bash
git remote add origin https://github.com/<username>/<repo>.git
git branch -M main
git push -u origin main
```
