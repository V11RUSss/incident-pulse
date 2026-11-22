FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    STATIC_DIR=/web

WORKDIR /app

COPY services/app/package.json ./package.json
COPY services/app/lib ./lib
COPY services/app/src ./src
COPY scripts/create-admin.js ./scripts/create-admin.js
COPY index.html app.js styles.css /web/
COPY wall.html wall.js wall.css /web/
COPY theme.js /web/

RUN chmod -R a+rX /app /web \
    && mkdir -p /data \
    && chown node:node /data

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
