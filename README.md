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

## GitHub setup
After local git initialization, create empty repo on GitHub and run:

```bash
git remote add origin https://github.com/<username>/<repo>.git
git branch -M main
git push -u origin main
```
