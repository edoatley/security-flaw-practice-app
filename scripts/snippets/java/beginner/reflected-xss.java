import java.io.IOException;
import javax.servlet.ServletException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class SearchServlet extends HttpServlet {

    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response)
            throws ServletException, IOException {

        response.setContentType("text/html;charset=UTF-8");

        String query = request.getParameter("q");

        response.getWriter().write(
            "<html><body><h1>Search Results</h1>"
            + "<p>You searched for: " + query + "</p>"
            + "</body></html>"
        );
    }
}
