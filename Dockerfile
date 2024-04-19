# Use a Node.js base image
FROM node:latest

# Set the working directory
WORKDIR /app

# Copy source code
COPY . .

# Install dependencies
RUN npm install -g pnpm

# Expose the port the app runs on
EXPOSE 2048

# Command to run the start script
CMD ["sh", "start.sh"]
