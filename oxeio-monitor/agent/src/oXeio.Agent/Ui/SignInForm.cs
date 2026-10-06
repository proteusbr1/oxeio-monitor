using System.Drawing;
using System.Runtime.Versioning;
using System.Windows.Forms;

using oXeio.Agent.Security;

namespace oXeio.Agent.Ui;

/// <summary>
/// <b>Staff add their own PC with their own email and password.</b>
///
/// Careful: in the old arrangement the admin had to create a one-time code for every PC,
/// have it used within 24 hours, and match <b>which code went to which machine</b> by hand.
/// A wrong match gave no error; one person's hours simply piled up under another's name, and
/// it was caught only at month end.
///
/// Careful: <b>the password is stored nowhere.</b> From here it goes straight to
/// <see cref="EnrollmentClient.SignInAsync"/>, where it is exchanged for a device token, and
/// only the token goes to disk (via DPAPI).
/// <see cref="TextBox.UseSystemPasswordChar"/> is set, and so is
/// <see cref="TextBox.MaxLength"/>; otherwise if someone pasted a whole file by mistake it
/// would go onto the wire.
///
/// Careful: the window is <b>modal</b> and <see cref="Form.TopMost"/>. After install this
/// is the first and only thing staff have to do; if it went behind other windows, the agent
/// would sit un-enrolled forever and nobody would notice.
///
/// Careful: there is <b>no Cancel button</b>, deliberately, but the window can be closed (X).
/// If closed, the agent keeps running, it just does not enroll; at the next logon it asks
/// again. Forcing it to stay would stop staff from starting work at all, and create
/// resentment toward the system on the first day.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class SignInForm : Form
{
    private readonly TrayTheme _theme = TrayTheme.Current;
    private readonly TrayFonts _fonts;
    private readonly bool _ownsFonts;

    private readonly TextBox _email = new();
    private readonly TextBox _password = new();
    private readonly TextBox _totp = new();
    private readonly Label _totpLabel = new();
    private readonly Label _message = new();
    private readonly Button _signIn = new();

    /// <summary>The function that does the real work; can be swapped in tests.</summary>
    private readonly Func<string, SecretText, string?, CancellationToken, Task<EnrollmentResult>> _signInAsync;

    private bool _busy;

    /// <summary>The bottom edge of the last field; the starting point of <see cref="Relayout"/>.</summary>
    private int _fieldsBottom;

    public SignInForm(
        string serverUrl,
        Func<string, SecretText, string?, CancellationToken, Task<EnrollmentResult>> signInAsync,
        TrayFonts? fonts = null)
    {
        _signInAsync = signInAsync;
        _fonts = fonts ?? new TrayFonts();
        _ownsFonts = fonts is null;

        var dpi = DeviceDpi;

        Text = "oXeio — sign in";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        TopMost = true;
        ShowInTaskbar = true;

        // Brand icon. Careful: this class does <b>not</b> inherit from OwnerDrawnForm, so it
        // cannot get this by setting it on the base class, yet staff see this window first
        // after install.
        Icon = BrandIcon.Value;
        BackColor = _theme.Surface;
        ForeColor = _theme.Ink;
        Font = _fonts.Get(TrayFontRole.Body, dpi);

        var y = Scale(18, dpi);

        var title = new Label
        {
            Text = "Sign in to start tracking",
            Font = _fonts.Get(TrayFontRole.Strong, dpi),
            ForeColor = _theme.Ink,
            // Careful: BackColor must be set explicitly. In WinForms a Label's default
            // BackColor is ambient, but an `AutoSize` label sometimes paints the system
            // `Control` color on the first paint; in a dark window that shows up as a pale
            // box behind every label.
            BackColor = _theme.Surface,
            AutoSize = true,
            Location = new Point(Scale(20, dpi), y),
        };
        Controls.Add(title);
        y += Scale(26, dpi);

        /**
         * The server address is shown on purpose, so staff know <b>where</b> the password is
         * going. This is the only place where they type their password into the office
         * system, and anyone can build a window that looks exactly like this.
         */
        var where = new Label
        {
            Text = serverUrl,
            Font = _fonts.Get(TrayFontRole.Small, dpi),
            ForeColor = _theme.Ink3,
            BackColor = _theme.Surface,
            AutoSize = true,
            Location = new Point(Scale(20, dpi), y),
        };
        Controls.Add(where);
        y += Scale(24, dpi);

        y = AddField("Work email", _email, y, dpi);
        _email.MaxLength = 200;

        y = AddField("Password", _password, y, dpi);
        _password.UseSystemPasswordChar = true;
        _password.MaxLength = 200;

        // Careful: the 2FA field is **hidden** at first; most staff have no 2FA, and seeing an
        // empty field makes people think they must fill something in.
        _totpLabel.Text = "6-digit code";
        // Careful: `y` is **not advanced**; the field is hidden, so no space is reserved.
        // `Relayout()` grows the window when it is shown.
        AddField(_totpLabel, _totp, y, dpi);
        _totp.MaxLength = 10;
        _totpLabel.Visible = false;
        _totp.Visible = false;

        _message.Size = new Size(Scale(340, dpi), Scale(32, dpi));
        _message.ForeColor = _theme.Brand;
        _message.BackColor = _theme.Surface;
        _message.Font = _fonts.Get(TrayFontRole.Small, dpi);
        Controls.Add(_message);

        _signIn.Text = "Sign in";
        _signIn.Size = new Size(Scale(100, dpi), Scale(30, dpi));
        _signIn.FlatStyle = FlatStyle.Flat;
        _signIn.FlatAppearance.BorderColor = _theme.Ink3;
        _signIn.BackColor = _theme.Line;
        _signIn.ForeColor = _theme.Ink;
        _signIn.Click += async (_, _) => await SubmitAsync().ConfigureAwait(true);
        Controls.Add(_signIn);

        // Pressing Enter signs in; that is the form's only action
        AcceptButton = _signIn;

        _fieldsBottom = y;
        Relayout();

        ActiveControl = _email;
    }

    /**
     * Careful: <b>the window height is not a hand-written constant; it is calculated.</b>
     *
     * The 2FA field is usually hidden, and then that space would sit empty; the first
     * screenshot showed exactly that: a large void in the middle and the button pushed up
     * against the edge. In the other direction, a height that was too small would put the
     * field **outside** the window for accounts with 2FA, and staff would have nowhere to
     * type the code.
     *
     * So there are two heights for the two states, and when the field is shown the window
     * grows by itself.
     */
    private void Relayout()
    {
        var dpi = DeviceDpi;
        var y = _fieldsBottom;

        if (_totp.Visible)
        {
            y += Scale(48, dpi);
        }

        _message.Location = new Point(Scale(20, dpi), y);
        y += _message.Height + Scale(6, dpi);

        _signIn.Location = new Point(Scale(380, dpi) - Scale(20, dpi) - _signIn.Width, y);

        ClientSize = new Size(Scale(380, dpi), y + _signIn.Height + Scale(18, dpi));
    }

    /// <summary>Filled in on success; the caller reads this to know what happened.</summary>
    public EnrollmentResult? Result { get; private set; }

    private int AddField(string label, TextBox box, int y, int dpi) =>
        AddField(new Label { Text = label }, box, y, dpi);

    private int AddField(Label label, TextBox box, int y, int dpi)
    {
        label.Font = _fonts.Get(TrayFontRole.Small, dpi);
        label.ForeColor = _theme.Ink2;
        label.BackColor = _theme.Surface;
        label.AutoSize = true;
        label.Location = new Point(Scale(20, dpi), y);
        Controls.Add(label);

        box.Location = new Point(Scale(20, dpi), y + Scale(16, dpi));
        box.Size = new Size(Scale(340, dpi), Scale(24, dpi));
        box.BorderStyle = BorderStyle.FixedSingle;
        box.BackColor = _theme.Line;
        box.ForeColor = _theme.Ink;
        box.Font = _fonts.Get(TrayFontRole.Body, dpi);
        Controls.Add(box);

        return y + Scale(48, dpi);
    }

    private async Task SubmitAsync()
    {
        // Careful: prevent a double press. Every failed attempt counts against the server's
        // brute-force counter, so a double-click would needlessly add two failures and the
        // lock would come sooner.
        if (_busy) return;

        _busy = true;
        _signIn.Enabled = false;
        _message.ForeColor = _theme.Ink2;
        _message.Text = "Signing in…";

        EnrollmentResult result;
        try
        {
            var password = new SecretText(_password.Text);
            var totp = _totp.Visible ? _totp.Text : null;

            result = await _signInAsync(_email.Text, password, totp, CancellationToken.None)
                .ConfigureAwait(true);
        }
        catch (Exception ex)
        {
            // Careful: throwing here means WinForms's unhandled handler, i.e. a crash dialog;
            // a sign-in mistake must not be allowed to kill the whole agent.
            result = new EnrollmentResult(
                EnrollmentStatus.ServerUnreachable, "Something went wrong: " + ex.Message);
        }

        _busy = false;
        _signIn.Enabled = true;

        if (result.Ok)
        {
            Result = result;
            DialogResult = DialogResult.OK;
            Close();
            return;
        }

        if (result.Status == EnrollmentStatus.NeedsTotp)
        {
            // Second step: the field is now visible, and the cursor goes there too
            _totpLabel.Visible = true;
            _totp.Visible = true;
            Relayout();
            _totp.Focus();
            _message.ForeColor = _theme.Ink2;
            _message.Text = result.Message;
            return;
        }

        _message.ForeColor = _theme.Brand;
        _message.Text = result.Message;

        // Careful: the password field is **not** cleared. If sign-in failed because of a wrong
        // 6-digit code, making the user type the password again would be pure punishment.
        _password.SelectAll();
        _password.Focus();
    }

    private static int Scale(int value, int dpi) => value * dpi / 96;

    protected override void Dispose(bool disposing)
    {
        if (disposing && _ownsFonts) _fonts.Dispose();
        base.Dispose(disposing);
    }
}
