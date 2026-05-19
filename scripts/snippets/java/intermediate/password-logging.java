package com.example.auth;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class LoginServlet extends javax.servlet.http.HttpServlet {

    private static final Logger log = LoggerFactory.getLogger(LoginServlet.class);

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp)
            throws javax.servlet.ServletException, java.io.IOException {

        String username = req.getParameter("username");
        String password = req.getParameter("password");

        log.info("Login attempt: username={}, password={}", username, password);

        boolean authenticated = authenticate(username, password);
        if (authenticated) {
            req.getSession(true).setAttribute("user", username);
            resp.sendRedirect("/dashboard");
        } else {
            log.warn("Failed login for user: {}", username);
            resp.sendError(HttpServletResponse.SC_UNAUTHORIZED);
        }
    }

    private boolean authenticate(String username, String password) {
        // authentication logic omitted for brevity
        return false;
    }
}
