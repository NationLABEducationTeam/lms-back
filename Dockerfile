# Use Node.js LTS version
FROM node:18-alpine

# Install wget for healthcheck
RUN apk add --no-cache wget

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
COPY package*.json ./
RUN npm ci --only=production

# Bundle app source
COPY . .

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "server.js"]