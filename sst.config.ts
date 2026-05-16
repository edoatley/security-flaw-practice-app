/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "security-flaw-practice-app",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws", // Targets AWS provider
    };
  },
  async run() {
    // 1. Define the Backend API Gateway (HTTP API v2)
    const api = new sst.aws.ApiGatewayV2("MyApi", {
      cors: {
        allowOrigins: ["*"], // Restrict this in production to your frontend URL
        allowMethods: ["GET", "POST", "PUT", "DELETE"],
      }
    });

    // 2. Define API Routes linked to Lambda Functions
    api.route("GET /api/hello", {
      handler: "backend/api.handler",
      memory: "1024 MB",
      timeout: "10 seconds",
    });

    // 3. Define the SPA Frontend (S3 + CloudFront website hosting)
    const web = new sst.aws.StaticSite("MyWeb", {
      path: "frontend",
      build: {
        command: "npm run build",
        output: "dist",
      },
      // Injects the live API Gateway URL into the frontend build environment variables
      environment: {
        VITE_API_URL: api.url,
      },
    });

    // Output values to the terminal screen on completion
    return {
      apiGatewayUrl: api.url,
      frontendUrl: web.url,
    };
  },
});