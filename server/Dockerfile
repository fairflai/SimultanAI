FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 8000
USER node
CMD ["node", "src/index.ts"]
