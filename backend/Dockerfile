FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY backend/package.json backend/package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

COPY backend/src ./src
COPY backend/tsconfig.json ./tsconfig.json

USER node
EXPOSE 3000
CMD ["npm", "run", "start:dev"]
