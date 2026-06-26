FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

EXPOSE 5000

# migrate at runtime, then start
CMD ["sh", "-c", "npm run start"]
