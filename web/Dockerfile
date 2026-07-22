FROM node:22-alpine AS build
WORKDIR /app
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
ARG API_BASE_URL=http://localhost:3000/api/v1
ENV API_BASE_URL=$API_BASE_URL
ENV DEV_AUTH=0
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
USER node
EXPOSE 3001
CMD ["node", "server.js"]
