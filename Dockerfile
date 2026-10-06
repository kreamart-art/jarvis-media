FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
ENV NODE_ENV=production PORT=3000 DATA_DIR=/tmp/jarvis-media
USER node
EXPOSE 3000
CMD ["node", "server.js"]
