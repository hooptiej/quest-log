FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY state.js docker-entrypoint.sh ./
COPY app ./app
COPY questhelper ./questhelper
RUN chmod +x docker-entrypoint.sh

EXPOSE 4242
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "app/server.js"]
