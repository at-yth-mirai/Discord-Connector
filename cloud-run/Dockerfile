# Use the official Node.js image
# https://hub.docker.com/_/node
FROM node:20-alpine

# Create and change to the app directory.
WORKDIR /usr/src/app

# Install pnpm
RUN npm install -g pnpm

# Copy application dependency manifests to the container image.
COPY package.json pnpm-lock.yaml* ./

# Install production dependencies.
RUN pnpm install --prod

# Copy local code to the container image.
COPY . ./

# Run the web service on container startup.
CMD [ "node", "index.js" ]
