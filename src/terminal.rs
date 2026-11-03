use anyhow::{Context, Result, bail};
use crossterm::{
    cursor::{Hide, Show},
    event::{
        self, DisableBracketedPaste, DisableMouseCapture, EnableBracketedPaste, EnableMouseCapture,
        Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
    },
    execute,
    terminal::{self, DisableLineWrap, EnableLineWrap, EnterAlternateScreen, LeaveAlternateScreen},
};
use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use std::{
    io::{self, Read, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Action {
    Picker,
    Escape,
    Tab,
    Up,
    Down,
    Live,
}

fn buttons(width: u16) -> Vec<(u16, u16, &'static str, Action)> {
    let mut x = 0;
    [
        ("‹ Picker", Action::Picker),
        ("Esc", Action::Escape),
        ("Tab", Action::Tab),
        ("↑", Action::Up),
        ("↓", Action::Down),
        ("Live", Action::Live),
    ]
    .into_iter()
    .filter_map(|(label, action)| {
        let len = UnicodeWidthStr::width(label) as u16 + 2;
        if x + len > width {
            return None;
        }
        let item = (x, x + len, label, action);
        x += len;
        Some(item)
    })
    .collect()
}

fn clipped(text: &str, width: u16) -> String {
    let text: String = text.chars().filter(|c| !c.is_control()).collect();
    let mut result = String::new();
    let mut used = 0;
    for grapheme in text.graphemes(true) {
        let size = UnicodeWidthStr::width(grapheme);
        if used + size > usize::from(width) {
            break;
        }
        result.push_str(grapheme);
        used += size;
    }
    result
}

struct RawScreen;
impl RawScreen {
    fn enter() -> Result<Self> {
        terminal::enable_raw_mode()?;
        let screen = Self;
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            DisableLineWrap,
            Hide,
            EnableMouseCapture,
            EnableBracketedPaste
        )?;
        write!(io::stdout(), "\x1b[2J")?;
        Ok(screen)
    }
}
impl Drop for RawScreen {
    fn drop(&mut self) {
        let _ = terminal::disable_raw_mode();
        let _ = execute!(
            io::stdout(),
            DisableMouseCapture,
            DisableBracketedPaste,
            EnableLineWrap,
            Show,
            LeaveAlternateScreen
        );
        let _ = io::stdout().flush();
    }
}

struct Attachment {
    process: Box<dyn portable_pty::Child + Send + Sync>,
    // portable-pty writes newline + EOF when this writer is dropped. It must
    // outlive hc attach, or that EOF can be forwarded into the user's shell.
    writer: Option<Box<dyn Write + Send>>,
}
impl Drop for Attachment {
    fn drop(&mut self) {
        if !matches!(self.process.try_wait(), Ok(Some(_))) {
            let _ = self.process.kill();
        }
        let _ = self.process.wait();
        // Fields (including writer) drop only after this method returns.
    }
}

/// Replies stay inside the virtual terminal; app queries cannot move Pocket's cursor.
#[derive(Default)]
struct Responses(Vec<u8>);
impl vt100::Callbacks for Responses {
    fn unhandled_csi(
        &mut self,
        screen: &mut vt100::Screen,
        first: Option<u8>,
        second: Option<u8>,
        params: &[&[u16]],
        code: char,
    ) {
        let param = params.first().and_then(|v| v.first()).copied().unwrap_or(0);
        let reply = match (first, second, code, param) {
            (None, None, 'n', 5) => "\x1b[0n".to_owned(),
            (None, None, 'n', 6) | (Some(b'?'), None, 'n', 6) => {
                let (row, col) = screen.cursor_position();
                format!(
                    "\x1b[{}{};{}R",
                    if first.is_some() { "?" } else { "" },
                    row + 1,
                    col + 1
                )
            }
            (None, None, 'c', 0) => "\x1b[?1;2c".to_owned(),
            (Some(b'>'), None, 'c', 0) => "\x1b[>0;136;0c".to_owned(),
            (Some(b'?'), Some(b'$'), 'p', mode) => format!("\x1b[?{mode};0$y"),
            (None, None, 't', 18) => {
                let (rows, cols) = screen.size();
                format!("\x1b[8;{rows};{cols}t")
            }
            _ => String::new(),
        };
        self.0.extend_from_slice(reply.as_bytes());
    }
    fn unhandled_osc(&mut self, _: &mut vt100::Screen, params: &[&[u8]]) {
        if let [which @ (b"10" | b"11"), b"?"] = params {
            self.0.extend_from_slice(b"\x1b]");
            self.0.extend_from_slice(which);
            self.0.extend_from_slice(if *which == b"10" {
                b";rgb:dddd/dddd/dddd\x1b\\"
            } else {
                b";rgb:1111/1111/1111\x1b\\"
            });
        }
    }
}

fn color(out: &mut String, foreground: bool, color: vt100::Color) {
    match color {
        vt100::Color::Default => (),
        vt100::Color::Idx(index) => {
            out.push_str(&format!(";{};5;{index}", if foreground { 38 } else { 48 }))
        }
        vt100::Color::Rgb(r, g, b) => out.push_str(&format!(
            ";{};2;{r};{g};{b}",
            if foreground { 38 } else { 48 }
        )),
    }
}

fn cell_style(cell: &vt100::Cell) -> String {
    let mut out = "\x1b[0".to_owned();
    for (active, code) in [
        (cell.bold(), 1),
        (cell.dim(), 2),
        (cell.italic(), 3),
        (cell.underline(), 4),
        (cell.inverse(), 7),
    ] {
        if active {
            out.push_str(&format!(";{code}"));
        }
    }
    color(&mut out, true, cell.fgcolor());
    color(&mut out, false, cell.bgcolor());
    out.push('m');
    out
}

fn paint(
    screen: &vt100::Screen,
    title: &str,
    width: u16,
    height: u16,
    cache: &mut Vec<String>,
) -> String {
    if width < 12 || height < 4 {
        return format!(
            "\x1b[?25l\x1b[H\x1b[0m{}\x1b[K",
            clipped("Resize · ^] picker", width)
        );
    }
    let rows = height - 2;
    let mut out = "\x1b[?25l".to_owned();
    cache.resize(usize::from(rows), String::new());
    for y in 0..rows {
        let mut row = String::new();
        let mut last = String::new();
        for x in 0..width {
            if let Some(cell) = screen.cell(y, x) {
                if cell.is_wide_continuation() {
                    continue;
                }
                let style = cell_style(cell);
                if style != last {
                    row.push_str(&style);
                    last = style;
                }
                if cell.has_contents() {
                    row.extend(cell.contents().chars().filter(|c| !c.is_control()));
                } else {
                    row.push(' ');
                }
            } else {
                row.push(' ');
            }
        }
        if cache[usize::from(y)] != row {
            out.push_str(&format!("\x1b[{};1H{row}\x1b[0m", y + 1));
            cache[usize::from(y)] = row;
        }
    }
    let title = clipped(
        &format!(
            "{}{title} · ^] picker",
            if screen.scrollback() > 0 {
                "History · "
            } else {
                ""
            }
        ),
        width,
    );
    out.push_str(&format!(
        "\x1b[{};1H\x1b[0;37;48;5;236m{title}{}\x1b[0m",
        rows + 1,
        " ".repeat(usize::from(width).saturating_sub(UnicodeWidthStr::width(title.as_str())))
    ));
    out.push_str(&format!(
        "\x1b[{height};1H\x1b[0;48;5;24m{}",
        " ".repeat(usize::from(width))
    ));
    for (start, _, label, action) in buttons(width) {
        out.push_str(&format!(
            "\x1b[{height};{}H\x1b[1;37;48;5;{}m {label} ",
            start + 1,
            if action == Action::Picker { 25 } else { 24 }
        ));
    }
    out.push_str("\x1b[0m");
    if screen.scrollback() == 0 && !screen.hide_cursor() {
        let (row, col) = screen.cursor_position();
        out.push_str(&format!(
            "\x1b[{};{}H\x1b[?25h",
            (row + 1).min(rows),
            (col + 1).min(width)
        ));
    }
    out
}

fn key_bytes(key: KeyEvent, application: bool) -> Vec<u8> {
    let ctrl = key.modifiers.contains(KeyModifiers::CONTROL);
    let alt = key.modifiers.contains(KeyModifiers::ALT);
    let shift = key.modifiers.contains(KeyModifiers::SHIFT);
    let modifier = 1 + u8::from(shift) + 2 * u8::from(alt) + 4 * u8::from(ctrl);
    let sequence = |last: char| {
        if modifier > 1 {
            format!("\x1b[1;{modifier}{last}")
        } else {
            format!("\x1b{}{last}", if application { 'O' } else { '[' })
        }
    };
    let tilde = |n| {
        if modifier > 1 {
            format!("\x1b[{n};{modifier}~")
        } else {
            format!("\x1b[{n}~")
        }
    };
    let mut text = match key.code {
        KeyCode::Up => sequence('A'),
        KeyCode::Down => sequence('B'),
        KeyCode::Right => sequence('C'),
        KeyCode::Left => sequence('D'),
        KeyCode::Home => sequence('H'),
        KeyCode::End => sequence('F'),
        KeyCode::Insert => tilde(2),
        KeyCode::Delete => tilde(3),
        KeyCode::PageUp => tilde(5),
        KeyCode::PageDown => tilde(6),
        KeyCode::BackTab => "\x1b[Z".into(),
        KeyCode::Esc => "\x1b".into(),
        KeyCode::Enter => "\r".into(),
        KeyCode::Tab => "\t".into(),
        KeyCode::Backspace => "\x7f".into(),
        KeyCode::F(n @ 1..=4) => {
            if modifier > 1 {
                format!("\x1b[1;{modifier}{}", char::from(b'P' + n - 1))
            } else {
                format!("\x1bO{}", char::from(b'P' + n - 1))
            }
        }
        KeyCode::F(n @ 5..=12) => tilde([15, 17, 18, 19, 20, 21, 23, 24][usize::from(n - 5)]),
        // Crossterm names legacy bytes 0x1c..0x1f Ctrl+4..7.
        KeyCode::Char(c @ '4'..='7') if ctrl => char::from(c as u8 - b'4' + 0x1c).to_string(),
        KeyCode::Char(c)
            if ctrl && (c.is_ascii_alphabetic() || ('@'..='_').contains(&c) || c == ' ') =>
        {
            char::from((c.to_ascii_uppercase() as u8) & 31).to_string()
        }
        KeyCode::Char('?') if ctrl => "\x7f".into(),
        KeyCode::Char(c) => c.to_string(),
        KeyCode::Null => "\0".into(),
        _ => String::new(),
    };
    if alt
        && matches!(
            key.code,
            KeyCode::Char(_) | KeyCode::Enter | KeyCode::Backspace | KeyCode::Tab
        )
    {
        text.insert(0, '\x1b');
    }
    text.into_bytes()
}

fn mouse_bytes(mouse: event::MouseEvent, screen: &vt100::Screen) -> Vec<u8> {
    use vt100::{MouseProtocolEncoding as Encoding, MouseProtocolMode as Mode};
    let mode = screen.mouse_protocol_mode();
    if mode == Mode::None {
        return vec![];
    }
    let button = |b| match b {
        MouseButton::Left => 0,
        MouseButton::Middle => 1,
        MouseButton::Right => 2,
    };
    let (mut code, release) = match mouse.kind {
        MouseEventKind::Down(b) => (button(b), false),
        MouseEventKind::Up(_) if mode == Mode::Press => return vec![],
        MouseEventKind::Up(b) => (button(b), true),
        MouseEventKind::Drag(b) if mode == Mode::ButtonMotion || mode == Mode::AnyMotion => {
            (32 + button(b), false)
        }
        MouseEventKind::Moved if mode == Mode::AnyMotion => (35, false),
        MouseEventKind::ScrollUp => (64, false),
        MouseEventKind::ScrollDown => (65, false),
        MouseEventKind::ScrollLeft => (66, false),
        MouseEventKind::ScrollRight => (67, false),
        _ => return vec![],
    };
    code += if mouse.modifiers.contains(KeyModifiers::SHIFT) {
        4
    } else {
        0
    };
    code += if mouse.modifiers.contains(KeyModifiers::ALT) {
        8
    } else {
        0
    };
    code += if mouse.modifiers.contains(KeyModifiers::CONTROL) {
        16
    } else {
        0
    };
    let x = mouse.column + 1;
    let y = mouse.row + 1;
    if screen.mouse_protocol_encoding() == Encoding::Sgr {
        format!("\x1b[<{code};{x};{y}{}", if release { 'm' } else { 'M' }).into_bytes()
    } else if screen.mouse_protocol_encoding() == Encoding::Utf8 {
        let mut text = "\x1b[M".to_owned();
        for n in [if release { 3 } else { code }, x, y] {
            if let Some(c) = char::from_u32(u32::from(n) + 32) {
                text.push(c);
            }
        }
        text.into_bytes()
    } else if x < 224 && y < 224 {
        vec![
            27,
            91,
            77,
            (if release { 3 } else { code }) as u8 + 32,
            x as u8 + 32,
            y as u8 + 32,
        ]
    } else {
        vec![]
    }
}

pub fn attach(address: &str, title: &str, stop: Arc<AtomicBool>) -> Result<()> {
    let (mut width, mut height) = terminal::size()?;
    width = width.max(1);
    height = height.max(1);
    let pty_size = |w: u16, h: u16| PtySize {
        rows: h.saturating_sub(2).max(1),
        cols: w.max(1),
        pixel_width: 0,
        pixel_height: 0,
    };
    let pair = native_pty_system().openpty(pty_size(width, height))?;
    let mut command = CommandBuilder::new(crate::core::hc_binary());
    command.args(["attach", address]);
    command.env("TERM", "xterm-256color");
    let mut child = Attachment {
        process: pair
            .slave
            .spawn_command(command)
            .context("Start hc attachment")?,
        writer: None,
    };
    drop(pair.slave);
    child.writer = Some(pair.master.take_writer()?);
    let writer = child.writer.as_mut().unwrap();
    let mut reader = pair.master.try_clone_reader()?;
    let (tx, rx) = mpsc::sync_channel(16);
    thread::spawn(move || {
        let mut bytes = [0; 8192];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(bytes[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let _raw = RawScreen::enter()?;
    let mut parser = vt100::Parser::new_with_callbacks(
        height.saturating_sub(2).max(1),
        width,
        5000,
        Responses::default(),
    );
    let mut cache = vec![];
    let mut dirty = true;
    let mut last_paint = Instant::now() - Duration::from_secs(1);
    while !stop.load(Ordering::Relaxed) {
        for _ in 0..16 {
            match rx.try_recv() {
                Ok(bytes) => {
                    parser.process(&bytes);
                    dirty = true;
                }
                Err(_) => break,
            }
        }
        let responses = std::mem::take(&mut parser.callbacks_mut().0);
        if !responses.is_empty() {
            writer.write_all(&responses)?;
            writer.flush()?;
        }
        if dirty && last_paint.elapsed() >= Duration::from_millis(24) {
            let frame = paint(parser.screen(), title, width, height, &mut cache);
            io::stdout().write_all(frame.as_bytes())?;
            io::stdout().flush()?;
            dirty = false;
            last_paint = Instant::now();
        }
        if let Some(status) = child.process.try_wait()? {
            if !status.success() {
                bail!("Attach ended (exit {}) · {address}", status.exit_code());
            }
            return Ok(());
        }
        if !event::poll(Duration::from_millis(16))? {
            continue;
        }
        let mut bytes = vec![];
        match event::read()? {
            Event::Resize(w, h) => {
                width = w.max(1);
                height = h.max(1);
                pair.master.resize(pty_size(width, height))?;
                parser
                    .screen_mut()
                    .set_size(height.saturating_sub(2).max(1), width);
                cache.clear();
                dirty = true;
            }
            Event::Key(key) if key.kind != KeyEventKind::Release => {
                if key.modifiers.contains(KeyModifiers::CONTROL)
                    && matches!(key.code, KeyCode::Char(']' | '\\' | '4' | '5'))
                {
                    return Ok(());
                }
                bytes = key_bytes(key, parser.screen().application_cursor());
                parser.screen_mut().set_scrollback(0);
                dirty = true;
            }
            Event::Paste(text) => {
                bytes = if parser.screen().bracketed_paste() {
                    format!("\x1b[200~{text}\x1b[201~").into_bytes()
                } else {
                    text.into_bytes()
                };
                parser.screen_mut().set_scrollback(0);
                dirty = true;
            }
            Event::Mouse(mouse) if width >= 12 && height >= 4 => {
                let screen_rows = height - 2;
                if mouse.row >= screen_rows {
                    if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
                        let action = if mouse.row == screen_rows {
                            Some(Action::Live)
                        } else {
                            buttons(width)
                                .into_iter()
                                .find(|(a, b, _, _)| mouse.column >= *a && mouse.column < *b)
                                .map(|(_, _, _, a)| a)
                        };
                        match action {
                            Some(Action::Picker) => return Ok(()),
                            Some(Action::Escape) => bytes.push(27),
                            Some(Action::Tab) => bytes.push(9),
                            Some(Action::Live) => parser.screen_mut().set_scrollback(0),
                            Some(direction @ (Action::Up | Action::Down)) => {
                                if parser.screen().alternate_screen() {
                                    bytes.extend_from_slice(if direction == Action::Up {
                                        b"\x1b[5~"
                                    } else {
                                        b"\x1b[6~"
                                    });
                                } else {
                                    let old = parser.screen().scrollback();
                                    let step = usize::from((screen_rows / 2).max(1));
                                    parser.screen_mut().set_scrollback(
                                        if direction == Action::Up {
                                            old.saturating_add(step)
                                        } else {
                                            old.saturating_sub(step)
                                        },
                                    );
                                }
                            }
                            None => (),
                        }
                        cache.clear();
                        dirty = true;
                    }
                } else if parser.screen().mouse_protocol_mode() == vt100::MouseProtocolMode::None
                    || parser.screen().scrollback() > 0
                {
                    let old = parser.screen().scrollback();
                    match mouse.kind {
                        MouseEventKind::ScrollUp => {
                            parser.screen_mut().set_scrollback(old.saturating_add(3))
                        }
                        MouseEventKind::ScrollDown => {
                            parser.screen_mut().set_scrollback(old.saturating_sub(3))
                        }
                        _ => (),
                    }
                    dirty = true;
                } else {
                    bytes = mouse_bytes(mouse, parser.screen());
                }
            }
            _ => (),
        }
        if !bytes.is_empty() {
            writer.write_all(&bytes)?;
            writer.flush()?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_clears_cannot_overwrite_controls() {
        let mut app = vt100::Parser::new(14, 32, 20);
        app.process(b"\x1b[2J\x1b[Hhello\x1b[14;1Hlast app row");
        let mut outer = vt100::Parser::new(16, 32, 0);
        outer.process(b"\x1b[?7l");
        outer.process(paint(app.screen(), "Session", 32, 16, &mut vec![]).as_bytes());
        let rows: Vec<_> = outer.screen().rows(0, 32).collect();
        assert!(rows[13].contains("last app row"));
        assert!(rows[14].contains("Session"));
        assert!(rows[15].contains("Picker"));
        for width in [12, 20, 32, 44] {
            assert!(buttons(width).iter().all(|(_, end, _, _)| *end <= width));
        }
    }
    #[test]
    fn keys_and_queries_round_trip() {
        assert_eq!(
            key_bytes(
                KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL),
                false
            ),
            [3]
        );
        assert_eq!(
            key_bytes(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE), true),
            b"\x1bOA"
        );
        assert_eq!(
            key_bytes(KeyEvent::new(KeyCode::Left, KeyModifiers::CONTROL), false),
            b"\x1b[1;5D"
        );
        assert_eq!(
            key_bytes(KeyEvent::new(KeyCode::Char('č'), KeyModifiers::NONE), false),
            "č".as_bytes()
        );
        let mut parser = vt100::Parser::new_with_callbacks(22, 44, 0, Responses::default());
        parser.process(b"\x1b[5;6H\x1b[6n\x1b[c\x1b[18t");
        assert_eq!(parser.callbacks().0, b"\x1b[5;6R\x1b[?1;2c\x1b[8;22;44t");
    }
}
