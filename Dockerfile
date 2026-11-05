FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY state.js docker-entrypoint.sh ./
COPY app ./app
COPY questhelper ./questhelper
COPY scripts ./scripts
COPY .claude-plugin ./.claude-plugin
RUN chmod +x docker-entrypoint.sh

# #156: the build stamp. Pass --build-arg BUILD_SHA=$(git rev-parse --short HEAD)
# and --build-arg BUILD_DATE=$(date +%F); app/build-stamp.js reads the file
# this writes. Kept last so changing the stamp busts only this layer.
ARG BUILD_SHA=""
ARG BUILD_DATE=""
RUN printf '{"build":"%s","built_at":"%s"}\n' "$BUILD_SHA" "$BUILD_DATE" > build-stamp.json

EXPOSE 4242
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "app/server.js"]
