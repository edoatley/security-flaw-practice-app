package com.example.auth;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

public class PasswordService {

    public String hashPassword(String plaintext) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] hashBytes = digest.digest(plaintext.getBytes());
            return HexFormat.of().formatHex(hashBytes);
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("Hash algorithm unavailable", e);
        }
    }

    public boolean verifyPassword(String plaintext, String storedHash) {
        return storedHash.equals(hashPassword(plaintext));
    }

    public void registerUser(String username, String plaintext) {
        String hash = hashPassword(plaintext);
        // persist username + hash to database
        saveToDatabase(username, hash);
    }

    private void saveToDatabase(String username, String hash) {
        // database persistence omitted for brevity
    }
}
