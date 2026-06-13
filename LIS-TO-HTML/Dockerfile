# -------------------------------
# Stage 1: Build the React app
# -------------------------------
FROM node:20-alpine AS build

# Set working directory
WORKDIR /app

# Install dependencies (using package.json + lock file)
COPY package*.json ./
RUN npm ci

# Copy all source code
COPY . .

# Build the React app (output goes to /app/dist)
RUN npm run build


# -------------------------------
# Stage 2: Production runtime
# -------------------------------
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy only package files first
COPY package*.json ./

# Install ONLY production dependencies
RUN npm ci --only=production

# Copy built React app from build stage
COPY --from=build /app/dist ./dist

# Copy server files
COPY server.cjs .
COPY index.html .

# Expose port for Azure Container Apps
EXPOSE 3002

# Health check (optional but recommended)
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3002', (r) => { if (r.statusCode !== 200) throw new Error(r.statusCode) })"

# Start the server
CMD ["node", "server.cjs"]
