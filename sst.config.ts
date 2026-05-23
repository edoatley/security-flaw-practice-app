/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "security-flaw-practice-app",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: {
        aws: { region: "eu-west-2" },
      },
    };
  },
  async run() {
    const isProd = $app.stage === "production";

    // 1. DynamoDB — single-table design
    const table = new sst.aws.Dynamo("AppTable", {
      fields: {
        PK: "string",
        SK: "string",
        GSI1PK: "string",
        GSI1SK: "string",
      },
      primaryIndex: { hashKey: "PK", rangeKey: "SK" },
      globalIndexes: {
        "GSI1PK-GSI1SK-index": { hashKey: "GSI1PK", rangeKey: "GSI1SK" },
      },
      billing: { mode: "on-demand" },
    });

    // 2. S3 bucket for snippet content
    const snippetBucket = new aws.s3.BucketV2("SnippetBucket", {
      forceDestroy: !isProd,
    });

    new aws.s3.BucketPublicAccessBlock("SnippetBucketPublicAccessBlock", {
      bucket: snippetBucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });

    // 3. Cognito User Pool — email + password only
    const hostedUiPrefix = `sfpa-793976-${$app.stage}`;
    const userPool = new sst.aws.CognitoUserPool("UserPool", {
      usernames: ["email"],
      domain: { prefix: hostedUiPrefix },
    });

    const localCallbackUrl = "https://localhost:5173/auth/callback";
    const localLogoutUrl = "https://localhost:5173";

    const deployedCallbackUrl = isProd
      ? "https://secure-train.edoatley.co.uk/auth/callback"
      : `https://${$app.stage}.secure-train.edoatley.co.uk/auth/callback`;

    const deployedLogoutUrl = isProd
      ? "https://secure-train.edoatley.co.uk"
      : `https://${$app.stage}.secure-train.edoatley.co.uk`;

    // Both localhost and deployed URL registered so sst dev works alongside deployed frontend
    const callbackUrls = isProd
      ? [deployedCallbackUrl]
      : [localCallbackUrl, deployedCallbackUrl];

    const logoutUrls = isProd
      ? [deployedLogoutUrl]
      : [localLogoutUrl, deployedLogoutUrl];

    // VITE_COGNITO_REDIRECT_URI always points to localhost when running sst dev
    const callbackUrl = localCallbackUrl;
    const logoutUrl = localLogoutUrl;

    const userPoolClient = userPool.addClient("UserPoolClient", {
      callbackUrls,
      transform: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        client: (args: any) => {
          args.logoutUrls = logoutUrls;
          args.generateSecret = false;
          args.allowedOauthFlows = ["code"];
          args.explicitAuthFlows = [
            "ALLOW_USER_SRP_AUTH",
            "ALLOW_REFRESH_TOKEN_AUTH",
            // Allow direct username/password auth in non-production stages for e2e tests
            ...(!isProd ? ["ALLOW_USER_PASSWORD_AUTH"] : []),
          ];
        },
      },
    });

    // 4. CloudFront distribution for snippet content (OAC)
    const snippetOriginAccessControl = new aws.cloudfront.OriginAccessControl(
      "SnippetOAC",
      {
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
      }
    );

    // CORS response headers policy — allows the SPA to fetch snippet content
    const snippetCorsPolicy = new aws.cloudfront.ResponseHeadersPolicy(
      "SnippetCorsPolicy",
      {
        corsConfig: {
          accessControlAllowCredentials: false,
          accessControlAllowHeaders: { items: ["*"] },
          accessControlAllowMethods: { items: ["GET", "HEAD"] },
          accessControlAllowOrigins: { items: ["*"] },
          originOverride: true,
        },
      }
    );

    const snippetDistribution = new aws.cloudfront.Distribution(
      "SnippetDistribution",
      {
        enabled: true,
        origins: [
          {
            originId: "snippetS3",
            domainName: snippetBucket.bucketRegionalDomainName,
            originAccessControlId: snippetOriginAccessControl.id,
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: "snippetS3",
          viewerProtocolPolicy: "redirect-to-https",
          allowedMethods: ["GET", "HEAD"],
          cachedMethods: ["GET", "HEAD"],
          forwardedValues: {
            queryString: false,
            cookies: { forward: "none" },
          },
          responseHeadersPolicyId: snippetCorsPolicy.id,
          minTtl: 0,
          defaultTtl: 86400,
          maxTtl: 31536000,
        },
        restrictions: {
          geoRestriction: { restrictionType: "none" },
        },
        viewerCertificate: {
          cloudfrontDefaultCertificate: true,
        },
      }
    );

    // Grant CloudFront OAC read access to the snippet bucket
    new aws.s3.BucketPolicy("SnippetBucketPolicy", {
      bucket: snippetBucket.id,
      policy: $jsonStringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "AllowCloudFrontServicePrincipal",
            Effect: "Allow",
            Principal: { Service: "cloudfront.amazonaws.com" },
            Action: "s3:GetObject",
            Resource: $interpolate`${snippetBucket.arn}/*`,
            Condition: {
              StringEquals: {
                "AWS:SourceArn": snippetDistribution.arn,
              },
            },
          },
        ],
      }),
    });

    // 5. API Gateway v2
    const api = new sst.aws.ApiGatewayV2("Api", {
      cors: {
        allowOrigins: isProd
          ? ["https://secure-train.edoatley.co.uk"]
          : [
              "https://localhost:5173",
              $interpolate`https://${$app.stage}.secure-train.edoatley.co.uk`,
              "https://*.cloudfront.net",
            ],
        allowMethods: ["GET", "POST"],
        allowHeaders: ["Authorization", "Content-Type", "Cookie"],
        allowCredentials: true,
      },
    });

    // JWT authorizer using Cognito
    const region = aws.getRegionOutput().name;
    const authorizer = api.addAuthorizer({
      name: "CognitoAuthorizer",
      jwt: {
        issuer: $interpolate`https://cognito-idp.${region}.amazonaws.com/${userPool.id}`,
        audiences: [userPoolClient.id],
      },
    });

    // Shared Lambda environment
    const sharedEnv = {
      TABLE_NAME: table.name,
      SNIPPET_BUCKET: snippetBucket.id,
      CLOUDFRONT_DOMAIN: snippetDistribution.domainName,
      COGNITO_USER_POOL_ID: userPool.id,
      COGNITO_CLIENT_ID: userPoolClient.id,
    };

    // 6. Lambda functions — game routes (JWT authorizer required)
    api.route(
      "GET /api/snippet",
      {
        handler: "backend/functions/get-snippet.handler",
        memory: "256 MB",
        timeout: "10 seconds",
        environment: sharedEnv,
        link: [table],
      },
      { auth: { jwt: { authorizer: authorizer.id } } }
    );

    api.route(
      "POST /api/answer",
      {
        handler: "backend/functions/submit-answer.handler",
        memory: "256 MB",
        timeout: "10 seconds",
        environment: sharedEnv,
        link: [table],
      },
      { auth: { jwt: { authorizer: authorizer.id } } }
    );

    api.route(
      "GET /api/progress",
      {
        handler: "backend/functions/get-progress.handler",
        memory: "256 MB",
        timeout: "10 seconds",
        environment: sharedEnv,
        link: [table],
      },
      { auth: { jwt: { authorizer: authorizer.id } } }
    );

    // Auth routes — no JWT authorizer
    const cognitoDomain = $interpolate`https://sfpa-793976-${$app.stage}.auth.${region}.amazoncognito.com`;

    const authEnv = {
      COGNITO_DOMAIN: cognitoDomain,
      COGNITO_CLIENT_ID: userPoolClient.id,
    };

    api.route("POST /auth/session", {
      handler: "backend/functions/auth-session.handler",
      memory: "128 MB",
      timeout: "10 seconds",
      environment: authEnv,
    });

    api.route("POST /auth/refresh", {
      handler: "backend/functions/auth-refresh.handler",
      memory: "128 MB",
      timeout: "10 seconds",
      environment: authEnv,
    });

    api.route("POST /auth/logout", {
      handler: "backend/functions/auth-logout.handler",
      memory: "128 MB",
      timeout: "10 seconds",
      environment: authEnv,
    });

    // 7. ComputeMedians Lambda — daily cron to refresh speed medians (@spec DIFF-027, DIFF-028)
    const computeMediansFunction = new sst.aws.Function("ComputeMedians", {
      handler: "backend/functions/compute-medians.handler",
      memory: "256 MB",
      timeout: "5 minutes",
      environment: { TABLE_NAME: table.name },
      link: [table],
    });

    new sst.aws.Cron("ComputeMediansCron", {
      schedule: "rate(24 hours)",
      job: computeMediansFunction,
    });

    // 8. Security response headers policy for the SPA CloudFront distribution
    const prodCsp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      `connect-src 'self' https://sfpa-793976-production.auth.eu-west-2.amazoncognito.com https://api.secure-train.edoatley.co.uk https://${snippetDistribution.domainName}`,
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join("; ");

    const devCsp = [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' https:",
      "object-src 'none'",
      "frame-ancestors 'none'",
    ].join("; ");

    const spaSecurityHeadersPolicy = new aws.cloudfront.ResponseHeadersPolicy(
      "SpaSecurityHeaders",
      {
        securityHeadersConfig: {
          contentSecurityPolicy: {
            contentSecurityPolicy: isProd ? prodCsp : devCsp,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAgeSec: 31536000,
            includeSubdomains: true,
            override: true,
          },
          contentTypeOptions: { override: true },
          frameOptions: { frameOption: "DENY", override: true },
          referrerPolicy: { referrerPolicy: "strict-origin-when-cross-origin", override: true },
          xssProtection: { modeBlock: true, protection: true, override: true },
        },
      }
    );

    // 9. Frontend SPA
    const web = new sst.aws.StaticSite("Web", {
      path: "frontend",
      build: {
        command: "npm run build",
        output: "dist",
      },
      errorPage: "index.html",
      environment: {
        VITE_API_URL: api.url,
        VITE_COGNITO_DOMAIN: cognitoDomain,
        VITE_COGNITO_CLIENT_ID: userPoolClient.id,
        VITE_COGNITO_REDIRECT_URI: callbackUrl,
      },
      transform: {
        cdn: (args) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const behavior = args.defaultCacheBehavior as any;
          behavior.responseHeadersPolicyId = spaSecurityHeadersPolicy.id;
        },
      },
    });

    return {
      apiUrl: api.url,
      frontendUrl: web.url,
      snippetCdnDomain: snippetDistribution.domainName,
      cognitoUserPoolId: userPool.id,
      cognitoClientId: userPoolClient.id,
      tableName: table.name,
      snippetBucket: snippetBucket.id,
    };
  },
});
