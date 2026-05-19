package com.example.proxy;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class WebhookProxyServlet extends javax.servlet.http.HttpServlet {

    private static final HttpClient client = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .build();

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws javax.servlet.ServletException, IOException {

        String targetUrl = req.getParameter("url");

        if (targetUrl == null || targetUrl.isBlank()) {
            resp.sendError(400, "Missing url parameter");
            return;
        }

        HttpRequest proxyReq = HttpRequest.newBuilder()
                .uri(URI.create(targetUrl))
                .timeout(Duration.ofSeconds(10))
                .GET()
                .build();

        try {
            HttpResponse<InputStream> proxyResp = client.send(
                    proxyReq, HttpResponse.BodyHandlers.ofInputStream());
            resp.setStatus(proxyResp.statusCode());
            resp.setContentType("application/octet-stream");
            proxyResp.body().transferTo(resp.getOutputStream());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            resp.sendError(504, "Request timed out");
        }
    }
}
