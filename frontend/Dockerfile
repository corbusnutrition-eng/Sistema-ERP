# syntax=docker/dockerfile:1

# ── Etapa 1: build — genera el bundle estático con Vite ──────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
# --legacy-peer-deps: react-quill@2.0.0-beta.4 declara peer react@^16||^17 y
# el proyecto usa react@19 (react-d3-tree sí soporta 19 vía su propio peer
# transitivo) — sin este flag `npm ci` aborta con ERESOLVE en una instalación
# limpia, aunque el árbol funciona en tiempo de ejecución.
RUN npm ci --legacy-peer-deps

COPY . .

# Vite incrusta las variables VITE_* en el bundle en tiempo de build: deben
# pasarse como --build-arg al construir la imagen (ver docker-compose.prod.yml).
ARG VITE_API_BASE_URL
ARG VITE_CODIGOS_RETIRO_BASE_URL
ARG VITE_CODIGOS_RETIRO_ES_PRUEBA
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_CODIGOS_RETIRO_BASE_URL=${VITE_CODIGOS_RETIRO_BASE_URL} \
    VITE_CODIGOS_RETIRO_ES_PRUEBA=${VITE_CODIGOS_RETIRO_ES_PRUEBA}

RUN npm run build

# ── Etapa 2: runtime — nginx sirviendo el build + reverse proxy al backend ──
FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
