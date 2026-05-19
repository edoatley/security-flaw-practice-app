package com.example.admin;

import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;

public class AdminLoginServlet extends javax.servlet.http.HttpServlet {

    private static final String ADMIN_USERNAME = "admin";
    private static final String ADMIN_PASSWORD = "s3cr3tAdm1n!";

    @Override
    protected void doPost(HttpServletRequest req, HttpServletResponse resp)
            throws javax.servlet.ServletException, java.io.IOException {

        String username = req.getParameter("username");
        String password = req.getParameter("password");

        if (ADMIN_USERNAME.equals(username) && ADMIN_PASSWORD.equals(password)) {
            HttpSession session = req.getSession(true);
            session.setAttribute("role", "ADMIN");
            resp.sendRedirect("/admin/dashboard");
        } else {
            resp.sendError(HttpServletResponse.SC_UNAUTHORIZED, "Invalid credentials");
        }
    }
}
