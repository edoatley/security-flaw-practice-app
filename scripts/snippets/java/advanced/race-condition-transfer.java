package com.example.banking;

import java.math.BigDecimal;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;

public class TransferService {

    private final Connection db;

    public TransferService(Connection db) {
        this.db = db;
    }

    public void transfer(String fromAccountId, String toAccountId, BigDecimal amount)
            throws Exception {

        BigDecimal fromBalance = getBalance(fromAccountId);

        if (fromBalance.compareTo(amount) < 0) {
            throw new IllegalStateException("Insufficient funds");
        }

        String debit = "UPDATE accounts SET balance = balance - ? WHERE account_id = ?";
        try (PreparedStatement ps = db.prepareStatement(debit)) {
            ps.setBigDecimal(1, amount);
            ps.setString(2, fromAccountId);
            ps.executeUpdate();
        }

        String credit = "UPDATE accounts SET balance = balance + ? WHERE account_id = ?";
        try (PreparedStatement ps = db.prepareStatement(credit)) {
            ps.setBigDecimal(1, amount);
            ps.setString(2, toAccountId);
            ps.executeUpdate();
        }
    }

    private BigDecimal getBalance(String accountId) throws Exception {
        String sql = "SELECT balance FROM accounts WHERE account_id = ?";
        try (PreparedStatement ps = db.prepareStatement(sql)) {
            ps.setString(1, accountId);
            ResultSet rs = ps.executeQuery();
            if (rs.next()) return rs.getBigDecimal("balance");
            throw new IllegalArgumentException("Account not found: " + accountId);
        }
    }
}
