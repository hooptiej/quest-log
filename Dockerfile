FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json ./
RUN npm install --omit=dev
COPY server.js template.html ./
COPY public ./public

EXPOSE 4242
CMD ["node", "server.js"]
