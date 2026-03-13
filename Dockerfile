FROM node:20-alpine AS base

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm install  ci --only=production

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

FROM node:20-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY --from=base /app/package.json ./
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/server.js"]

