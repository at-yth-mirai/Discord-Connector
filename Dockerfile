FROM node:20-alpine

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm install --production

# Bundle app source
COPY bot.js ./

# Cloud Run requires the port to be exposed (process.env.PORT)
EXPOSE 8080
CMD [ "npm", "start" ]
