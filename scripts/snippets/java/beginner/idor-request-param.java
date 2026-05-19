package com.example.banking;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import javax.servlet.http.HttpSession;
import java.io.PrintWriter;

public class AccountServlet extends javax.servlet.http.HttpServlet {

    private Connection db;

    @Override
    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws javax.servlet.ServletException, java.io.IOException {

        HttpSession session = req.getSession(false);
        String loggedInUser = (String) session.getAttribute("userId");

        String requestedUserId = req.getParameter("userId");

        String sql = "SELECT balance, account_number FROM accounts WHERE user_id = ?";
        try (PreparedStatement ps = db.prepareStatement(sql)) {
            ps.setString(1, requestedUserId);
            ResultSet rs = ps.executeQuery();
            PrintWriter out = resp.getWriter();
            if (rs.next()) {
                out.printf("{\"balance\": %.2f, \"account\": \"%s\"}%n",
                        rs.getDouble("balance"), rs.getString("account_number"));
            }
        } catch (Exception e) {
            resp.sendError(500, "Internal error");
        }
    }
}
