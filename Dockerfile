FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json ./
COPY web/package.json web/package.json
RUN npm install

COPY . .

EXPOSE 5173

CMD ["npm", "run", "dev"]
