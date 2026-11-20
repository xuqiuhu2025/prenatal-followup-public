# Disposable integration lab. No ports or carrier credentials are needed.
FROM node:22-alpine3.22
RUN apk add --no-cache asterisk ffmpeg
WORKDIR /lab
COPY server/package*.json ./server/
RUN cd server && npm ci --ignore-scripts --no-audit --no-fund
COPY server/ ./server/
COPY init/ ./init/
COPY telephony/ ./telephony/
COPY tests/ ./tests/
CMD ["node", "tests/telephony-asterisk.cjs"]
