import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

public class UserRepository {

    private Connection getConnection() throws Exception {
        return DriverManager.getConnection(
            "jdbc:mysql://localhost/appdb", "user", "password"
        );
    }

    public boolean authenticate(String username, String password) throws Exception {
        Connection conn = getConnection();
        Statement stmt = conn.createStatement();
        String query = "SELECT * FROM users WHERE username = '" + username
                     + "' AND password = '" + password + "'";
        ResultSet rs = stmt.executeQuery(query);
        return rs.next();
    }

    public static void main(String[] args) throws Exception {
        UserRepository repo = new UserRepository();
        boolean ok = repo.authenticate("alice", "secret");
        System.out.println("Authenticated: " + ok);
    }
}
