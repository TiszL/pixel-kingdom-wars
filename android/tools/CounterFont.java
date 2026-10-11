import java.awt.*;
import java.awt.font.*;
import java.awt.geom.AffineTransform;
import java.awt.image.BufferedImage;
import java.nio.file.*;
import java.security.MessageDigest;
import java.util.HexFormat;
import javax.imageio.ImageIO;

/** Run from the repo root with JDK17: java -Djava.awt.headless=true tools/CounterFont.java.
 * Rasterizes only counter glyphs from the already licensed web VT323 conversion.
 * No platform fallback, source font modification or runtime font dependency. */
class CounterFont {
    public static void main(String[] args) throws Exception {
        var source = Path.of("app/src/main/res/font/pkw_vt323.ttf");
        var hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(Files.readAllBytes(source)));
        if (!hash.equals("693e750814d8237856efa80dffbaf724345e94431b3a12414147fef6b5b7e8a7"))
            throw new IllegalStateException("VT323 source changed; review provenance before regeneration");
        var font = Font.createFont(Font.TRUETYPE_FONT, source.toFile()).deriveFont(32f);
        var context = new FontRenderContext(new AffineTransform(), false, false);
        var image = new BufferedImage(256, 64, BufferedImage.TYPE_INT_ARGB);
        var graphics = image.createGraphics();
        graphics.setColor(Color.WHITE);
        graphics.setRenderingHint(RenderingHints.KEY_TEXT_ANTIALIASING, RenderingHints.VALUE_TEXT_ANTIALIAS_OFF);
        graphics.setRenderingHint(RenderingHints.KEY_FRACTIONALMETRICS, RenderingHints.VALUE_FRACTIONALMETRICS_OFF);
        var glyphs = " 0123456789×M";
        var base = (int)Math.ceil(font.getLineMetrics(glyphs, context).getAscent());
        var data = new StringBuilder("info face=\"VT323\" size=32 bold=0 italic=0 charset=\"\" unicode=1 stretchH=100 smooth=0 aa=1 padding=0,0,0,0 spacing=1,1\n")
            .append("common lineHeight=32 base=").append(base).append(" scaleW=256 scaleH=64 pages=1 packed=0\n")
            .append("page id=0 file=\"counter-vt323.png\"\nchars count=").append(glyphs.length()).append('\n');
        var x = 1;
        for (char c : glyphs.toCharArray()) {
            if (!font.canDisplay(c)) throw new IllegalStateException("Missing original glyph: " + (int)c);
            var glyph = font.createGlyphVector(context, new char[]{c});
            var bounds = glyph.getPixelBounds(context, 0, 0);
            if (x + bounds.width >= image.getWidth() || 2 + bounds.height >= image.getHeight())
                throw new IllegalStateException("Counter atlas overflow");
            graphics.drawGlyphVector(glyph, x - bounds.x, 2 - bounds.y);
            data.append("char id=").append((int)c).append(" x=").append(x).append(" y=2 width=").append(bounds.width)
                .append(" height=").append(bounds.height).append(" xoffset=").append(bounds.x)
                .append(" yoffset=").append(base + bounds.y).append(" xadvance=").append(Math.round(glyph.getGlyphMetrics(0).getAdvanceX()))
                .append(" page=0 chnl=15\n");
            x += bounds.width + 2;
        }
        graphics.dispose();
        var output = Path.of("renderer/src/main/resources/ui");
        Files.createDirectories(output);
        ImageIO.write(image, "png", output.resolve("counter-vt323.png").toFile());
        Files.writeString(output.resolve("counter-vt323.fnt"), data.append("kernings count=0\n"));
        System.out.println("Generated original VT323 counter atlas: " + glyphs.length() + " glyphs");
    }
}
