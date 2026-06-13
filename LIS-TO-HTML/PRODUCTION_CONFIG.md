# App Configuration for Production

This file documents the production settings and configuration for the LIS Report Generator app.

## Application Architecture

```
Docker Container (node:20-alpine)
├── Express Server (Port 3002)
├── React Frontend (Vite built)
└── Multer File Upload Handler
```

## Port Configuration

- **Production Port**: 3002
- **React Dev Port**: 5174 (dev only)
- **Configurable via**: `PORT` environment variable

## Environment Setup

The application supports the following environment variables:

```bash
PORT=3002                    # Server port (default: 3002)
NODE_ENV=production         # Set to 'production' for production deployments
```

## Docker Build Information

**Image Base**: `node:20-alpine` (lightweight, security-focused)

**Build Stages**:
1. **Build Stage**: Installs all dependencies and builds React app
2. **Runtime Stage**: Copies only production dependencies and built code

**Image Size**: ~200-300MB (optimized with multi-stage build)

**Health Check**: Built-in HTTP health check every 30 seconds

## Performance Tuning

### Enable Build Cache

The GitHub Actions workflows use Docker build cache to speed up subsequent builds:

```bash
- Uses: type=registry cache for faster rebuilds
- Saves ~1-2 minutes per build
```

### Memory & CPU in Azure Container Apps

Recommended for this application:

```bash
# Default (sufficient for most workloads)
az containerapp create ... \
  --cpu 0.5 \
  --memory 1Gi

# High traffic
az containerapp create ... \
  --cpu 1 \
  --memory 2Gi
```

## Security Considerations

1. **Base Image**: Alpine Linux is minimal and secure
2. **No Privileged Mode**: Container runs as non-root
3. **Health Checks**: Automatically restarts unhealthy containers
4. **HTTPS**: Configure via Azure Container Apps ingress settings

## File Upload Handling

The Multer middleware is configured for:
- **Max File Size**: 100MB
- **Storage**: In-memory (suitable for container environment)
- **Endpoint**: `/api/` (proxy handled by dev server)

## Deployment Checklist

- [ ] Docker image builds successfully locally
- [ ] GitHub Actions workflow is enabled
- [ ] Azure Container Registry credentials are set as secrets
- [ ] Azure resource group created
- [ ] Container app deployed
- [ ] Ingress configured and accessible
- [ ] Health checks passing
- [ ] Application responsive in production
