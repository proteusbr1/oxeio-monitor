using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.Versioning;
using System.Windows.Forms;

namespace oXeio.Agent.Ui;

/// <summary>
/// The base of the tray's small windows: fully owner-drawn, with no child controls.
///
/// Why there is no Label/Button:
///  1) With no controls there is no input: the window is read-only by construction, and
///     nothing can be typed or pressed anywhere by mistake (ADR-011d: staff must have
///     nothing to press).
///
/// Careful: text is drawn with <see cref="TextRenderer"/>, not <c>Graphics.DrawString</c>.
/// Measuring and drawing have to use the same engine: <c>MeasureText</c> gives GDI's result,
/// while <c>DrawString</c> draws with GDI+, and their kerning differs, so the last word of a
/// measured box would be silently clipped. Other WinForms controls also draw with GDI, so
/// the window's text matches the system.
/// </summary>
[SupportedOSPlatform("windows")]
internal abstract class OwnerDrawnForm : Form
{
    private const TextFormatFlags TextFlags =
        TextFormatFlags.NoPrefix | TextFormatFlags.WordBreak | TextFormatFlags.NoPadding;

    private readonly TrayFonts _fonts;
    private readonly int _baseWidth;
    private readonly int _baseHeight;
    private bool _resizing;

    private readonly TrayTheme _theme = TrayTheme.Current;

    protected OwnerDrawnForm(TrayFonts fonts, string title, int baseWidth, int baseHeight)
    {
        _fonts = fonts;
        _baseWidth = baseWidth;
        _baseHeight = baseHeight;

        Text = title;
        FormBorderStyle = FormBorderStyle.FixedDialog;

        // Minimize is present: the window can be tucked away while working.
        //
        // Careful: there is no maximize: everything inside is laid out for a 400px width
        // (owner-drawn, no layout engine), so enlarging would crowd the text into the left
        // corner and leave the rest empty.
        //
        // Careful: even so, the button **will be visible on the title bar, greyed out**. That
        // is Windows's behavior, not ours: if either minimize or maximize is present it draws
        // both and disables the missing one. Removing the style bit (`WS_MAXIMIZEBOX`) by hand
        // does not help either; we tried. To remove it we would have to draw the whole title
        // bar ourselves, which is disproportionate for this window.
        MinimizeBox = true;
        MaximizeBox = false;
        ShowInTaskbar = true;

        /**
         * <b>The taskbar and title bar icon</b>: the brand's red tile.
         *
         * Careful: <b>both are needed; it is the pair that matters, not the order.</b> This
         * used to have <c>ShowIcon = false</c>, and then even setting <c>Icon</c> leaves the
         * window icon <b>empty</b>. We measured it: with FixedDialog + ShowIcon=false + Icon
         * set, <c>WM_GETICON</c> still returns 0 for all three slots. So setting just
         * <c>Icon</c> and thinking "done" would have been a <b>silent</b> mistake.
         */
        Icon = BrandIcon.Value;
        ShowIcon = true;

        KeyPreview = true;
        StartPosition = FormStartPosition.Manual;

        // Careful: WinForms's own scaling is off. We measure everything ourselves from
        // DeviceDpi; if both ran together, everything would be scaled twice on a 150% monitor.
        AutoScaleMode = AutoScaleMode.None;

        BackColor = _theme.Surface;
        ForeColor = _theme.Ink;
        DoubleBuffered = true;

        SetStyle(
            ControlStyles.AllPaintingInWmPaint |
            ControlStyles.UserPaint |
            ControlStyles.OptimizedDoubleBuffer |
            ControlStyles.ResizeRedraw,
            true);
    }

    protected TrayFonts Fonts => _fonts;

    /// <summary>A size at 96 DPI to this monitor's size.</summary>
    protected int Scale(int value) => (int)Math.Round(value * DeviceDpi / 96.0);

    protected Font FontFor(TrayFontRole role) => _fonts.Get(role, DeviceDpi);

    protected TrayTheme Theme => _theme;

    protected Color Muted => _theme.Ink3;

    // ── thumbnail cache ─────────────────────────────────────────────────────
    private string? _thumbPath;
    private DateTime _thumbStamp;
    private Bitmap? _thumbImage;

    /// <summary>
    /// The decoded thumbnail, <b>only once per file</b>.
    ///
    /// Careful: it used to read from disk and decode the WebP on every paint. Painting was
    /// rare (when the status changed), so it went unnoticed, but once the per-second clock was
    /// added to <see cref="TodayForm"/> it paints <b>every second</b>, and that meant a file
    /// read plus a decode every second.
    ///
    /// It compares the file's <b>write time</b>, not just the name: when a new image arrives
    /// the path stays the same (<c>last-shot.webp</c>), so caching by name would make the
    /// window show the first image forever.
    /// </summary>
    internal Bitmap? ThumbnailFor(string path)
    {
        DateTime stamp;
        try { stamp = File.GetLastWriteTimeUtc(path); }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }

        if (_thumbImage is not null && _thumbPath == path && _thumbStamp == stamp)
        {
            return _thumbImage;
        }

        var loaded = WebpImage.Load(path);
        if (loaded is null) return null;

        _thumbImage?.Dispose();
        _thumbImage = loaded;
        _thumbPath = path;
        _thumbStamp = stamp;

        return _thumbImage;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _thumbImage?.Dispose();
            _thumbImage = null;
        }

        base.Dispose(disposing);
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        TrayNative.TryUseDarkTitleBar(Handle);
        ApplyDpi();
    }

    protected override void OnDpiChanged(DpiChangedEventArgs e)
    {
        base.OnDpiChanged(e);
        ApplyDpi();
    }

    private void ApplyDpi()
    {
        try
        {
            ClientSize = new Size(Scale(_baseWidth), Scale(_baseHeight));
            Invalidate();
        }
        catch (ObjectDisposedException)
        {
        }
    }

    /// <summary>
    /// The bottom-right of the work area of the monitor the mouse is on, i.e. next to the tray.
    ///
    /// Careful: <c>WorkingArea</c> is used, not <c>Bounds</c>: even if the taskbar has been
    /// moved to the top or side, the window does not slip under it.
    /// </summary>
    public void PositionNearTray()
    {
        try
        {
            var area = Screen.FromPoint(Cursor.Position).WorkingArea;
            var margin = Scale(12);

            var x = area.Right - Width - margin;
            var y = area.Bottom - Height - margin;

            // At a very small resolution it would go negative and end up off screen
            Location = new Point(Math.Max(area.Left, x), Math.Max(area.Top, y));
        }
        catch (Exception)
        {
            StartPosition = FormStartPosition.CenterScreen;
        }
    }

    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);

        // Esc closes. Because there is no button, a keyboard route needs to exist.
        if (e.KeyCode == Keys.Escape) Close();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        // Careful: in WinForms an exception escaping OnPaint brings down the whole process.
        // A drawing bug in one window must not stop the hours being counted.
        try
        {
            e.Graphics.Clear(BackColor);

            var pad = Scale(16);
            var body = new Rectangle(
                pad, pad,
                Math.Max(1, ClientSize.Width - (2 * pad)),
                Math.Max(1, ClientSize.Height - (2 * pad)));

            var stack = new TextStack(this, e.Graphics, body);
            PaintBody(stack);
            GrowIfClipped(stack.Bottom + pad);
        }
        catch (Exception)
        {
        }
    }

    /// <summary>
    /// The window grows a little taller by itself if text overflows at the bottom.
    ///
    /// Why it is needed: how much room text will take cannot be counted in advance; it changes
    /// with the font, the DPI, and even the fallback font's metrics if Segoe UI is missing.
    /// With a fixed height the last line would be silently clipped on some machines, and the
    /// clipped line is often the reassurance line like "data saved locally".
    ///
    /// Careful: we change size inside paint, so a flag prevents re-entry. Growing is needed
    /// only once: the next paint no longer overflows, so there is no loop.
    /// </summary>
    private void GrowIfClipped(int neededHeight)
    {
        if (_resizing || neededHeight <= ClientSize.Height) return;

        _resizing = true;
        try
        {
            ClientSize = new Size(ClientSize.Width, neededHeight);
            Invalidate();
        }
        catch (ObjectDisposedException)
        {
        }
        finally
        {
            _resizing = false;
        }
    }

    protected abstract void PaintBody(TextStack stack);

    /// <summary>
    /// A small helper for stacking lines top to bottom: it measures each line's height and
    /// places the next one accordingly, so there is no overlap even if long text wraps to two lines.
    /// </summary>
    protected sealed class TextStack
    {
        private readonly OwnerDrawnForm _form;
        private readonly Graphics _g;
        private readonly Rectangle _bounds;
        private int _y;

        internal TextStack(OwnerDrawnForm form, Graphics g, Rectangle bounds)
        {
            _form = form;
            _g = g;
            _bounds = bounds;
            _y = bounds.Top;
        }

        /// <summary>The bottom edge of the text drawn so far; needed to set the window height.</summary>
        public int Bottom => _y;

        public void Gap(int basePixels) => _y += _form.Scale(basePixels);

        public void Line(string text, TrayFontRole role = TrayFontRole.Body, Color? color = null)
        {
            if (string.IsNullOrEmpty(text)) return;

            var font = _form.FontFor(role);
            var width = _bounds.Width;

            var size = TextRenderer.MeasureText(
                _g, text, font, new Size(width, int.MaxValue), TextFlags);

            TextRenderer.DrawText(
                _g, text, font,
                new Rectangle(_bounds.Left, _y, width, size.Height),
                color ?? _form.ForeColor,
                TextFlags);

            _y += size.Height + _form.Scale(3);
        }

        /// <summary>On one line: label on the left, value on the right.</summary>
        public void Pair(string label, string value, TrayFontRole role = TrayFontRole.Body)
        {
            var font = _form.FontFor(role);

            // Careful: the sample must contain both an ascender and a descender ("Ag"). With
            // just "A", GDI would measure the height without room for the descender, and the
            // tails of values containing "g"/"y" would rub against the next line.
            var height = TextRenderer.MeasureText(
                _g, "Ag", font, new Size(_bounds.Width, int.MaxValue), TextFlags).Height;

            // Careful: not an exact half and half. Labels are short ("Now", "Sync") and values
            // long ("127:30 / 208 hours"); splitting evenly would clip the number on the right.
            var labelWidth = _bounds.Width * 2 / 5;

            TextRenderer.DrawText(
                _g, label, font,
                new Rectangle(_bounds.Left, _y, labelWidth, height),
                _form.Theme.Ink2, TextFlags);

            TextRenderer.DrawText(
                _g, value, font,
                new Rectangle(_bounds.Left + labelWidth, _y, _bounds.Width - labelWidth, height),
                _form.ForeColor,
                TextFlags | TextFormatFlags.Right);

            _y += height + _form.Scale(3);
        }

        public void Rule()
        {
            Gap(6);
            using var pen = new Pen(_form.Theme.Line, 1f);
            _g.DrawLine(pen, _bounds.Left, _y, _bounds.Right, _y);
            Gap(8);
        }

        /// <summary>
        /// The progress bar. Careful: only <b>the drawing</b> is clamped to 1; per the rules of
        /// <see cref="oXeio.Core.Agent.AgentStatus.MonthlyProgress"/> the written percentage is
        /// not clamped, otherwise the extra work of someone who worked 220 hours would vanish.
        /// </summary>
        public void Bar(double ratio, Color fill, int baseHeight = 10)
        {
            var height = _form.Scale(baseHeight);
            var track = new Rectangle(_bounds.Left, _y, _bounds.Width, height);

            using (var brush = new SolidBrush(_form.Theme.Track))
            {
                _g.FillRectangle(brush, track);
            }

            var clamped = double.IsNaN(ratio) ? 0 : Math.Min(1.0, Math.Max(0.0, ratio));
            var filled = (int)Math.Round(track.Width * clamped);

            if (filled > 0)
            {
                using var brush = new SolidBrush(fill);
                _g.FillRectangle(brush, new Rectangle(track.X, track.Y, filled, height));
            }

            _y += height + _form.Scale(6);
        }

        // ── new primitives ──────────────────────────────────────────────────

        /// <summary>
        /// The hero row: a big number, the unit beside it, and the state chip on the right.
        ///
        /// The state is here because <b>this</b> is the only thing in the window that changes
        /// minute by minute. It used to be the fourth row of a four-row list ("Now: Working"),
        /// i.e. the same weight as "Queued: 0".
        /// </summary>
        /// <param name="tail">
        /// The last piece of the number, drawn at <b>half size</b>, e.g. the <c>:22</c> of
        /// <c>3:59:22</c> (the owner's request, 18 August).
        /// If empty, the whole number is at hero size.
        /// </param>
        public void Hero(
            string figure, string? tail, string unit, string? chip, Color chipDot)
        {
            var heroFont = _form.FontFor(TrayFontRole.Hero);
            var tailFont = _form.FontFor(TrayFontRole.HeroSeconds);
            var unitFont = _form.FontFor(TrayFontRole.Body);

            var heroSize = TextRenderer.MeasureText(
                _g, figure, heroFont, new Size(_bounds.Width, int.MaxValue), TextFlags);

            TextRenderer.DrawText(
                _g, figure, heroFont,
                new Rectangle(_bounds.Left, _y, _bounds.Width, heroSize.Height),
                _form.Theme.Ink, TextFlags);

            var used = heroSize.Width;

            if (!string.IsNullOrEmpty(tail))
            {
                var tailSize = TextRenderer.MeasureText(
                    _g, tail, tailFont, new Size(_bounds.Width, int.MaxValue), TextFlags);

                /**
                 * Careful: **placed by matching baselines, not by top or bottom.**
                 *
                 * Placed by the top, the small digits would hang from the head; placed by the
                 * bottom, because of the descent difference (the descent at 44px is double that
                 * at 22px) they would drop **below** the big digits' baseline. Both look
                 * broken. Since the two fonts share a family and style, ascent is proportional
                 * to size, so the calculation is reliable.
                 */
                var tailY = _y + AscentPx(heroFont) - AscentPx(tailFont);

                TextRenderer.DrawText(
                    _g, tail, tailFont,
                    new Rectangle(
                        _bounds.Left + heroSize.Width, tailY,
                        _bounds.Width - heroSize.Width, tailSize.Height),
                    _form.Theme.Ink, TextFlags);

                used += tailSize.Width;
            }

            // Careful: the unit sits on the number's baseline, not at the top; otherwise "hours
            // today" would float level with the head of the number.
            var unitSize = TextRenderer.MeasureText(
                _g, unit, unitFont, new Size(_bounds.Width, int.MaxValue), TextFlags);

            var unitY = _y + heroSize.Height - unitSize.Height - _form.Scale(6);

            TextRenderer.DrawText(
                _g, unit, unitFont,
                new Rectangle(
                    _bounds.Left + used + _form.Scale(8), unitY,
                    _bounds.Width - used, unitSize.Height),
                _form.Theme.Ink2, TextFlags);

            if (!string.IsNullOrEmpty(chip))
            {
                DrawChip(chip, chipDot, _y + ((heroSize.Height - _form.Scale(24)) / 2));
            }

            _y += heroSize.Height + _form.Scale(2);
        }

        /// <summary>
        /// How many pixels below the top of the text the baseline is.
        ///
        /// Careful: because drawing uses <see cref="TextFormatFlags.NoPadding"/>, the glyph cell
        /// sits exactly at the top of the rect, so the ascent is directly the distance.
        /// Careful: <c>font.Size</c> here is in <b>pixels</b> (fonts are created in
        /// <see cref="GraphicsUnit.Pixel"/>, see <see cref="TrayFonts"/>); if it were in
        /// points this calculation would break with DPI.
        /// </summary>
        private static int AscentPx(Font font)
        {
            var family = font.FontFamily;
            var em = family.GetEmHeight(font.Style);

            // em should never be zero, but if it were, the division would give NaN and the text
            // would end up outside the window; better that it sits at the top instead.
            if (em <= 0) return 0;

            return (int)Math.Round(font.Size * family.GetCellAscent(font.Style) / em);
        }

        /// <summary>A pill on the right: a coloured dot inside, and the state name.</summary>
        private void DrawChip(string text, Color dot, int top)
        {
            var font = _form.FontFor(TrayFontRole.Small);
            var height = _form.Scale(24);
            var padX = _form.Scale(9);
            var dotSize = _form.Scale(8);

            var textSize = TextRenderer.MeasureText(
                _g, text, font, new Size(_bounds.Width, int.MaxValue), TextFlags);

            var width = padX + dotSize + _form.Scale(6) + textSize.Width + padX;
            var box = new Rectangle(_bounds.Right - width, top, width, height);

            var mode = _g.SmoothingMode;
            _g.SmoothingMode = SmoothingMode.AntiAlias;

            using (var path = Pill(box))
            using (var pen = new Pen(_form.Theme.Line, 1f))
            {
                _g.DrawPath(pen, path);
            }

            using (var brush = new SolidBrush(dot))
            {
                _g.FillEllipse(brush, new Rectangle(
                    box.Left + padX, box.Top + ((height - dotSize) / 2), dotSize, dotSize));
            }

            _g.SmoothingMode = mode;

            TextRenderer.DrawText(
                _g, text, font,
                new Rectangle(
                    box.Left + padX + dotSize + _form.Scale(6),
                    box.Top + ((height - textSize.Height) / 2),
                    textSize.Width + _form.Scale(2), textSize.Height),
                _form.Theme.Ink2, TextFlags);
        }

        /// <summary>
        /// The month meter: the fill, plus a mark for "how much should be done by today".
        ///
        /// Important: the mark is the biggest change in this window. The figure "79:20 hours
        /// behind" alone is just an accusation; it says neither how far behind nor how many months
        /// it would take to make up. With the mark, the gap is visible <b>before</b> reading.
        ///
        /// Careful: the fill is at least 3px. 0:39 / 208 hours is 0.3%, which is 1.1px at 360px,
        /// and GDI would round it to <b>zero</b>. Then "a little work done" and "nothing done"
        /// would look identical. A true zero stays zero, of course.
        /// </summary>
        public void Meter(double ratio, double? expected, Color fill, int baseHeight = 10)
        {
            var height = _form.Scale(baseHeight);
            var radius = height / 2;

            // The mark's label sits above the meter, so reserve the space first
            var labelFont = _form.FontFor(TrayFontRole.Micro);
            var labelHeight = expected is null
                ? 0
                : TextRenderer.MeasureText(
                    _g, "Ag", labelFont, new Size(_bounds.Width, int.MaxValue), TextFlags).Height
                  + _form.Scale(3);

            _y += labelHeight;

            var track = new Rectangle(_bounds.Left, _y, _bounds.Width, height);

            var mode = _g.SmoothingMode;
            _g.SmoothingMode = SmoothingMode.AntiAlias;

            using (var path = Pill(track))
            using (var brush = new SolidBrush(_form.Theme.Track))
            {
                _g.FillPath(brush, path);
            }

            var clamped = double.IsNaN(ratio) ? 0 : Math.Min(1.0, Math.Max(0.0, ratio));
            if (clamped > 0)
            {
                var filled = Math.Max(_form.Scale(3), (int)Math.Round(track.Width * clamped));
                filled = Math.Min(filled, track.Width);

                using var path = Pill(new Rectangle(track.X, track.Y, filled, height));
                using var brush = new SolidBrush(fill);
                _g.FillPath(brush, path);
            }

            _g.SmoothingMode = mode;

            if (expected is { } mark and >= 0 and <= 1)
            {
                var x = track.Left + (int)Math.Round(track.Width * mark);
                var tickTop = track.Top - _form.Scale(3);
                var tickBottom = track.Bottom + _form.Scale(3);

                using (var pen = new Pen(_form.Theme.Ink2, _form.Scale(2)))
                {
                    _g.DrawLine(pen, x, tickTop, x, tickBottom);
                }

                const string caption = "expected by today";
                var capSize = TextRenderer.MeasureText(
                    _g, caption, labelFont, new Size(_bounds.Width, int.MaxValue), TextFlags);

                // Careful: clamped at both ends; at the start or end of the month the text
                // would go outside the window.
                var capX = Math.Min(
                    Math.Max(_bounds.Left, x - (capSize.Width / 2)),
                    _bounds.Right - capSize.Width);

                TextRenderer.DrawText(
                    _g, caption, labelFont,
                    new Rectangle(capX, _y - labelHeight, capSize.Width, capSize.Height),
                    _form.Theme.Ink3, TextFlags);
            }

            _y += height + _form.Scale(6);
        }

        /// <summary>Two small texts, left and right: the line under the meter.</summary>
        public void Legend(string left, string right, Color rightColor)
        {
            var font = _form.FontFor(TrayFontRole.Small);
            var height = TextRenderer.MeasureText(
                _g, "Ag", font, new Size(_bounds.Width, int.MaxValue), TextFlags).Height;

            TextRenderer.DrawText(
                _g, left, font,
                new Rectangle(_bounds.Left, _y, _bounds.Width / 2, height),
                _form.Theme.Ink3, TextFlags);

            TextRenderer.DrawText(
                _g, right, font,
                new Rectangle(
                    _bounds.Left + (_bounds.Width / 2), _y, _bounds.Width / 2, height),
                rightColor,
                TextFlags | TextFormatFlags.Right);

            _y += height + _form.Scale(3);
        }

        /// <summary>
        /// The machine's three facts in one row: small uppercase labels, mono values below.
        ///
        /// These used to be three separate rows, each with the same weight as every other line.
        /// They are things to <b>glance at</b>, not to <b>read</b>.
        /// </summary>
        public void Readout((string Key, string Value, Color? Color)[] cells)
        {
            if (cells.Length == 0) return;

            var keyFont = _form.FontFor(TrayFontRole.Micro);
            var valueFont = _form.FontFor(TrayFontRole.Mono);

            var keyHeight = TextRenderer.MeasureText(
                _g, "AG", keyFont, new Size(_bounds.Width, int.MaxValue), TextFlags).Height;
            var valueHeight = TextRenderer.MeasureText(
                _g, "Ag", valueFont, new Size(_bounds.Width, int.MaxValue), TextFlags).Height;

            var column = _bounds.Width / cells.Length;
            var gap = _form.Scale(8);

            for (var i = 0; i < cells.Length; i++)
            {
                var x = _bounds.Left + (i * column);
                var w = column - gap;

                TextRenderer.DrawText(
                    _g, cells[i].Key.ToUpperInvariant(), keyFont,
                    new Rectangle(x, _y, w, keyHeight),
                    _form.Theme.Ink3,
                    TextFlags | TextFormatFlags.EndEllipsis);

                TextRenderer.DrawText(
                    _g, cells[i].Value, valueFont,
                    new Rectangle(x, _y + keyHeight + _form.Scale(2), w, valueHeight),
                    cells[i].Color ?? _form.Theme.Ink,
                    TextFlags | TextFormatFlags.EndEllipsis);
            }

            _y += keyHeight + valueHeight + _form.Scale(6);
        }

        /// <summary>
        /// Only when something is wrong: one sentence in a box.
        ///
        /// Careful: red appears <b>only here</b> in this window. "Behind" is not red: that is
        /// the employee's tally, and this is a system failure.
        /// </summary>
        public void Alert(string text)
        {
            if (string.IsNullOrEmpty(text)) return;

            var font = _form.FontFor(TrayFontRole.Small);
            var padX = _form.Scale(10);
            var padY = _form.Scale(8);
            var inner = _bounds.Width - (2 * padX);

            var size = TextRenderer.MeasureText(
                _g, text, font, new Size(inner, int.MaxValue), TextFlags);

            var box = new Rectangle(
                _bounds.Left, _y, _bounds.Width, size.Height + (2 * padY));

            var mode = _g.SmoothingMode;
            _g.SmoothingMode = SmoothingMode.AntiAlias;

            using (var path = Rounded(box, _form.Scale(6)))
            using (var pen = new Pen(_form.Theme.Brand, 1f))
            {
                _g.DrawPath(pen, path);
            }

            _g.SmoothingMode = mode;

            TextRenderer.DrawText(
                _g, text, font,
                new Rectangle(box.Left + padX, box.Top + padY, inner, size.Height),
                _form.Theme.Ink, TextFlags);

            _y += box.Height + _form.Scale(6);
        }

        /// <summary>
        /// One target row: name on the left, "how much / how much" on the right, the bar below.
        ///
        /// The three targets (today · 7 days · month) are laid out in the same shape, on
        /// purpose: three different looks would make the eye read anew each time, yet the question
        /// is always one: "how much is done".
        ///
        /// If <paramref name="ratio"/> is <c>null</c> the bar is not drawn at all; in the
        /// "don't know" state, showing an empty bar would be saying "you have done nothing".
        /// </summary>
        public void TargetRow(
            string label, string value, double? ratio, Color fill,
            double? expected = null, string? note = null, Color? noteColor = null)
        {
            var labelFont = _form.FontFor(TrayFontRole.Body);
            var height = TextRenderer.MeasureText(
                _g, "Ag", labelFont, new Size(_bounds.Width, int.MaxValue), TextFlags).Height;

            TextRenderer.DrawText(
                _g, label, labelFont,
                new Rectangle(_bounds.Left, _y, _bounds.Width / 2, height),
                _form.Theme.Ink2, TextFlags);

            TextRenderer.DrawText(
                _g, value, labelFont,
                new Rectangle(_bounds.Left + (_bounds.Width / 2), _y, _bounds.Width / 2, height),
                _form.Theme.Ink,
                TextFlags | TextFormatFlags.Right);

            _y += height + _form.Scale(4);

            if (ratio is { } r)
            {
                Meter(r, expected, fill, 8);
            }
            else
            {
                Line("Waiting for the server…", TrayFontRole.Small, _form.Theme.Ink3);
            }

            if (!string.IsNullOrEmpty(note))
            {
                _y -= _form.Scale(3);
                Line(note, TrayFontRole.Small, noteColor ?? _form.Theme.Ink3);
            }
        }

        /// <summary>
        /// What percentage of the time the hands were active in the last few 5-minute cells (B13).
        ///
        /// Careful: this is <b>not keystroke counting</b>; counting would be keylogging
        /// (04-Features § L · G46). Each bar says "for what share of that 5 minutes the keyboard
        /// or mouse moved", not what moved.
        ///
        /// Careful: even a zero score gets a 1px line; otherwise "0% busy" and "no data for this
        /// cell at all" would look identical on screen.
        /// </summary>
        public void BusyBlocks(IReadOnlyList<int> scores, int blocks, int baseHeight = 26)
        {
            var height = _form.Scale(baseHeight);
            var gap = _form.Scale(3);
            var width = (_bounds.Width - (gap * (blocks - 1))) / blocks;

            // Careful: newest on the right; with few cells the left side stays empty, otherwise
            // in a freshly started agent the bars would jump around changing places.
            var missing = Math.Max(0, blocks - scores.Count);

            for (var i = 0; i < blocks; i++)
            {
                var x = _bounds.Left + (i * (width + gap));
                var slot = new Rectangle(x, _y, width, height);

                using (var back = new SolidBrush(_form.Theme.Track))
                {
                    _g.FillRectangle(back, slot);
                }

                if (i < missing) continue;

                var score = Math.Clamp(scores[i - missing], 0, 100);
                var filled = Math.Max(_form.Scale(1), (int)Math.Round(height * score / 100.0));

                // Solid green (Theme.Ok): the owner's request (18 August), the same language as
                // the target bars. Careful: a zero score gets a 1px line in dim Ink3, otherwise
                // "0% busy" and "no data" would look the same.
                using var brush = new SolidBrush(
                    score == 0 ? _form.Theme.Ink3 : _form.Theme.Ok);

                _g.FillRectangle(
                    brush, new Rectangle(x, slot.Bottom - filled, width, filled));
            }

            _y += height + _form.Scale(5);
        }

        /// <summary>
        /// The last captured image. Careful: a thumbnail, not the full image; the window's
        /// job is "show what went out", not image analysis.
        ///
        /// If the file is missing or cannot be read, returns <c>false</c> and draws nothing;
        /// the caller can then write something else.
        /// </summary>
        public bool Thumbnail(string? path, int baseWidth)
        {
            if (string.IsNullOrEmpty(path) || !File.Exists(path)) return false;

            // Careful: `Image.FromStream` does **not** work here: the image is WebP, and GDI+
            // has no such codec. It says "Parameter is not valid", which reads as if the file
            // were corrupt. SkiaSharp (WebpImage) decodes it, and is there anyway.
            // Careful: no `using`: the image belongs to the form's cache and is not decoded
            // again on every paint (ThumbnailFor). Disposing here would leave the cached image
            // unusable on the next paint.
            var image = _form.ThumbnailFor(path);
            if (image is null) return false;

            try
            {
                var width = _form.Scale(baseWidth);
                var height = (int)Math.Round(width * (double)image.Height / image.Width);

                var box = new Rectangle(_bounds.Left, _y, width, height);

                _g.DrawImage(image, box);

                using (var pen = new Pen(_form.Theme.Line, 1f))
                {
                    _g.DrawRectangle(pen, box);
                }

                _y += height + _form.Scale(6);
                return true;
            }
            catch (Exception e) when (e is IOException or ArgumentException or OutOfMemoryException)
            {
                // GDI+ throws OutOfMemoryException on a broken image; memory has not really
                // run out, that is just their historical quirk
                return false;
            }
        }

        private static GraphicsPath Pill(Rectangle box) =>
            Rounded(box, box.Height / 2);

        /// <summary>
        /// Careful: <c>Graphics.FillRoundedRectangle</c> does not exist in .NET 8, so the path
        /// is built by hand. If the radius is more than half the height/width the arcs would
        /// overlap and invert the shape, so it is clamped first.
        /// </summary>
        private static GraphicsPath Rounded(Rectangle box, int radius)
        {
            var path = new GraphicsPath();

            var r = Math.Max(1, Math.Min(radius, Math.Min(box.Width, box.Height) / 2));
            var d = r * 2;

            path.AddArc(box.Left, box.Top, d, d, 180, 90);
            path.AddArc(box.Right - d, box.Top, d, d, 270, 90);
            path.AddArc(box.Right - d, box.Bottom - d, d, d, 0, 90);
            path.AddArc(box.Left, box.Bottom - d, d, d, 90, 90);
            path.CloseFigure();

            return path;
        }
    }
}
