FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY src ./src
COPY public ./public
EXPOSE 3002
CMD ["node", "src/index.js"]
