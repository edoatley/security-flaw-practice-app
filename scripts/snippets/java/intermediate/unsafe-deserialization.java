package com.example.session;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.ObjectInputStream;
import java.util.Base64;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class SessionRestoreServlet extends javax.servlet.http.HttpServlet {

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws javax.servlet.ServletException, IOException {

        String sessionCookie = null;
        for (Cookie c : req.getCookies()) {
            if ("session_state".equals(c.getName())) {
                sessionCookie = c.getValue();
                break;
            }
        }

        if (sessionCookie == null) {
            resp.sendError(400, "Missing session cookie");
            return;
        }

        byte[] decoded = Base64.getDecoder().decode(sessionCookie);
        try (ObjectInputStream ois = new ObjectInputStream(new ByteArrayInputStream(decoded))) {
            Object sessionData = ois.readObject();
            req.getSession(true).setAttribute("data", sessionData);
        } catch (ClassNotFoundException e) {
            resp.sendError(400, "Invalid session");
        }

        resp.sendRedirect("/home");
    }
}
