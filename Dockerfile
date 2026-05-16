FROM node:20-alpine

WORKDIR /app/backend

COPY backend/package*.json ./

RUN npm install

COPY backend ./

RUN npm run build || true

EXPOSE 5000

CMD ["npm", "start"]
