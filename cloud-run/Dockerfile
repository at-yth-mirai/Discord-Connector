# Use the official Node.js image
FROM node:20-alpine

# Create and change to the app directory.
WORKDIR /usr/src/app

# Copy package.json (lockファイルは無視してOKです)
COPY package.json ./

# npmを使って確実・フラットにインストールする
RUN npm install

# Copy local code to the container image.
COPY . ./

# Run the web service on container startup.
CMD [ "node", "index.js" ]