# Azure Container App Deployment Guide

This guide explains how to deploy the LIS Report Generator React app to Azure Container Apps using GitHub Actions.

## Prerequisites

- GitHub repository (public or private)
- Azure subscription
- Azure Container Registry (ACR) or Docker credentials
- Docker installed locally (for testing)

## Quick Setup

### 1. **Create Azure Container Registry**

```bash
# Create resource group
az group create --name lis-report-rg --location eastus

# Create container registry
az acr create --resource-group lis-report-rg \
  --name lisreportregistry --sku Basic
```

### 2. **Get ACR Credentials**

```bash
az acr credential show --name lisreportregistry
```

Save the following as GitHub Secrets:
- `AZURE_REGISTRY_LOGIN_SERVER`: Your registry URL (e.g., `lisreportregistry.azurecr.io`)
- `AZURE_REGISTRY_USERNAME`: Registry username
- `AZURE_REGISTRY_PASSWORD`: Registry password

### 3. **Push to GitHub**

```bash
git add .
git commit -m "Add Docker and GitHub Actions for Azure deployment"
git push origin main
```

The GitHub Actions workflow will automatically build and push your image to ACR.

### 4. **Deploy to Azure Container Apps**

```bash
# Create container app environment
az containerapp env create \
  --name lis-report-env \
  --resource-group lis-report-rg \
  --location eastus

# Deploy container app
az containerapp create \
  --name lis-report-app \
  --resource-group lis-report-rg \
  --environment lis-report-env \
  --image lisreportregistry.azurecr.io/lis-report-generator:latest \
  --target-port 3002 \
  --ingress external \
  --registry-server lisreportregistry.azurecr.io \
  --registry-username <ACR_USERNAME> \
  --registry-password <ACR_PASSWORD>
```

## Environment Variables

Set these in Azure Container Apps if needed:

```bash
az containerapp update \
  --name lis-report-app \
  --resource-group lis-report-rg \
  --set-env-vars PORT=3002
```

## GitHub Actions Workflows

Two workflows are provided:

### `build.yml` (GitHub Container Registry)
- Builds and pushes to GitHub Container Registry (GHCR)
- Automatically triggered on push to main/develop
- No additional secrets needed (uses `GITHUB_TOKEN`)

### `azure-deploy.yml` (Azure Container Registry)
- Builds and pushes to your Azure Container Registry
- Requires Azure registry credentials as GitHub Secrets
- Recommended for production deployments

## Local Testing

### Build Docker image locally

```bash
docker build -t lis-report-generator:latest .
```

### Run container locally

```bash
docker run -p 3002:3002 lis-report-generator:latest
```

Visit http://localhost:3002 to test the app.

## Environment Variables in Production

Update the container app to set environment variables if needed:

```bash
az containerapp update \
  --name lis-report-app \
  --resource-group lis-report-rg \
  --set-env-vars \
    PORT=3002 \
    NODE_ENV=production
```

## Scaling

Configure auto-scaling rules:

```bash
az containerapp update \
  --name lis-report-app \
  --resource-group lis-report-rg \
  --min-replicas 1 \
  --max-replicas 5 \
  --scale-rule-name http-scale \
  --scale-rule-type http \
  --scale-rule-http-concurrency 100
```

## Troubleshooting

### Check logs

```bash
az containerapp logs show \
  --name lis-report-app \
  --resource-group lis-report-rg
```

### Check deployment status

```bash
az containerapp show \
  --name lis-report-app \
  --resource-group lis-report-rg
```

### GitHub Actions logs

Check the "Actions" tab in your GitHub repository to see build logs.

## Cleanup

```bash
# Delete container app
az containerapp delete --name lis-report-app --resource-group lis-report-rg

# Delete environment
az containerapp env delete --name lis-report-env --resource-group lis-report-rg

# Delete resource group
az group delete --name lis-report-rg
```

## Additional Resources

- [Azure Container Apps Documentation](https://learn.microsoft.com/en-us/azure/container-apps/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Docker Documentation](https://docs.docker.com/)
