import java.io.StringReader;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.xml.sax.InputSource;

public class XmlParser {

    public Document parseXml(String xmlInput) throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        DocumentBuilder builder = factory.newDocumentBuilder();
        InputSource source = new InputSource(new StringReader(xmlInput));
        return builder.parse(source);
    }

    public static void main(String[] args) throws Exception {
        XmlParser parser = new XmlParser();
        String xml = "<root><item>Hello</item></root>";
        Document doc = parser.parseXml(xml);
        System.out.println("Root element: " + doc.getDocumentElement().getTagName());
    }
}
