FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY README.md ./

USER node
EXPOSE 3000
CMD ["npm", "start"]