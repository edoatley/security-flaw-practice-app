package com.example.app;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import java.io.IOException;

public class UserGreetingServlet extends javax.servlet.http.HttpServlet {

    private static final Logger logger = LogManager.getLogger(UserGreetingServlet.class);

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws javax.servlet.ServletException, IOException {

        String username = req.getHeader("X-Forwarded-User");
        if (username == null) {
            username = req.getParameter("user");
        }

        logger.info("Processing request for user: " + username);

        String userAgent = req.getHeader("User-Agent");
        logger.debug("Request user-agent: {}", userAgent);

        resp.setContentType("text/plain");
        resp.getWriter().println("Hello, " + sanitize(username));
    }

    private String sanitize(String input) {
        if (input == null) return "Guest";
        return input.replaceAll("[<>\"']", "");
    }
}
