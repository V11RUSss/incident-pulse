FROM node:24-alpine

WORKDIR /app

COPY services/itsm-mock/package.json ./package.json
COPY services/itsm-mock/src ./src

RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/data

EXPOSE 3001
USER node

CMD ["node", "src/server.js"]
