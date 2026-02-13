FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_TELEGRAM_BOT_NAME=
ARG VITE_API_URL=
ARG VITE_ADMIN=
RUN if [ -f .env ]; then export $(grep -v '^#' .env | xargs); fi \
    && if [ -n "$VITE_TELEGRAM_BOT_NAME" ]; then export VITE_TELEGRAM_BOT_NAME="$VITE_TELEGRAM_BOT_NAME"; fi \
    && if [ -n "$VITE_API_URL" ]; then export VITE_API_URL="$VITE_API_URL"; fi \
    && if [ -n "$VITE_ADMIN" ]; then export VITE_ADMIN="$VITE_ADMIN"; fi \
    && npm run build

FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
