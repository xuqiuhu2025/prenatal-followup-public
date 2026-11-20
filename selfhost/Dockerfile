FROM node:18-alpine

RUN apk add --no-cache ffmpeg openssl

WORKDIR /app

COPY server/package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server/ ./
COPY init/03-customers.sql ./customer-schema.sql
COPY init/04-hospital.sql ./hospital-schema.sql
COPY init/05-accounts.sql ./accounts-schema.sql
COPY init/06-prenatal.sql ./prenatal-schema.sql
COPY init/07-telephone.sql ./telephone-schema.sql
COPY webapp/ ./webapp/

ENV NODE_ENV=production
EXPOSE 3000 9092

CMD ["node", "index.js"]
