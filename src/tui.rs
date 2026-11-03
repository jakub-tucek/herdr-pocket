//! Mobile-sized picker. Network work never runs on the input thread.
use crate::backend::{Backend, Launch};
use crate::model::{Repository, Space, Terminal, World};
use anyhow::Result;
use crossterm::{
    cursor,
    event::{
        self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEventKind,
    },
    execute,
    terminal::{self, Clear, ClearType, EnterAlternateScreen, LeaveAlternateScreen},
};
use serde::{Deserialize, Serialize};
use std::{
    io::{self, Write},
    path::PathBuf,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Repository,
    Space,
    Terminal,
    Heading,
    Disabled,
    Checkout,
    Action,
}
#[derive(Clone, Debug)]
struct Row {
    id: String,
    label: String,
    meta: String,
    kind: Kind,
    address: Option<String>,
    path: Option<String>,
    action: Option<&'static str>,
    status: Option<&'static str>,
}
impl Row {
    fn new(id: impl Into<String>, label: impl Into<String>, kind: Kind) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            meta: String::new(),
            kind,
            address: None,
            path: None,
            action: None,
            status: None,
        }
    }
    fn selectable(&self) -> bool {
        !matches!(self.kind, Kind::Heading | Kind::Disabled)
    }
}

fn clean(text: &str) -> String {
    // Strip complete CSI/OSC sequences as well as control characters. Remote
    // titles are untrusted and must never become terminal commands.
    let mut out = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\x1b' {
            match chars.next() {
                Some('[') => {
                    for x in chars.by_ref() {
                        if ('@'..='~').contains(&x) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(x) = chars.next() {
                        if x == '\x07' || (x == '\x1b' && chars.peek() == Some(&'\\')) {
                            if x == '\x1b' {
                                chars.next();
                            }
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if !c.is_control() {
            out.push(c);
        }
    }
    out
}
fn clip(text: &str, width: usize) -> String {
    let text = clean(text);
    if text.width() <= width {
        return text;
    }
    if width == 0 {
        return String::new();
    }
    let mut out = String::new();
    for g in text.graphemes(true) {
        if out.width() + g.width() + 1 > width {
            break;
        }
        out.push_str(g);
    }
    out.push('…');
    out
}
fn pad(text: &str, width: usize) -> String {
    let text = clip(text, width);
    format!("{}{}", text, " ".repeat(width.saturating_sub(text.width())))
}
fn search_line(query: &str, cursor: usize, width: usize) -> String {
    let prefix = format!("{}: ", clip("Find", width / 3));
    let chars: Vec<_> = query.chars().collect();
    let cursor = cursor.min(chars.len());
    let current = chars.get(cursor).copied().unwrap_or(' ').to_string();
    let room = width.saturating_sub(prefix.width() + current.width());
    let mut start = 0;
    while start < cursor && chars[start..cursor].iter().collect::<String>().width() > room {
        start += 1;
    }
    let before: String = chars[start..cursor].iter().collect();
    let suffix: String = chars.iter().skip(cursor + 1).collect();
    let remaining = width.saturating_sub(prefix.width() + before.width() + current.width());
    format!(
        "{prefix}{}\x1b[7m{}\x1b[27m{}",
        clean(&before),
        clean(&current),
        clip(&suffix, remaining)
    )
}
fn terminal_status(t: &Terminal) -> Option<&'static str> {
    crate::model::status(Some(t))
}
fn terminals(space: &Space) -> impl Iterator<Item = &Terminal> {
    space
        .tabs
        .iter()
        .flat_map(|t| &t.panes)
        .flat_map(|p| p.terminal.iter().chain(p.children.iter()))
}
fn rollup<'a>(ts: impl Iterator<Item = &'a Terminal>) -> Option<&'static str> {
    let statuses: Vec<_> = ts.filter_map(terminal_status).collect();
    ["blocked", "done", "working", "idle"]
        .into_iter()
        .find(|s| statuses.contains(s))
}
fn terminal_label(t: &Terminal) -> String {
    t.name
        .as_ref()
        .or_else(|| t.status.as_ref().and_then(|s| s.title.as_ref()))
        .or(t.title.as_ref())
        .or_else(|| t.foreground.as_ref().and_then(|f| f.name.as_ref()))
        .cloned()
        .unwrap_or_else(|| "shell".into())
}
fn terminal_search(t: &Terminal) -> String {
    [
        t.address.as_str(),
        t.name.as_deref().unwrap_or(""),
        t.title.as_deref().unwrap_or(""),
        t.status
            .as_ref()
            .and_then(|s| s.title.as_deref())
            .unwrap_or(""),
        t.foreground
            .as_ref()
            .and_then(|f| f.name.as_deref())
            .unwrap_or(""),
    ]
    .join(" ")
}
fn session_rows(space: &Space) -> Vec<Row> {
    let mut rows = Vec::new();
    for tab in &space.tabs {
        if space.tabs.len() > 1 {
            rows.push(Row::new(&tab.id, &tab.name, Kind::Heading));
        }
        for pane in &tab.panes {
            let Some(address) = &pane.address else {
                rows.push(Row::new(
                    &pane.id,
                    format!("{} · desktop", pane.mod_name.as_deref().unwrap_or("Panel")),
                    Kind::Disabled,
                ));
                continue;
            };
            let mut row = Row::new(
                &pane.id,
                pane.terminal
                    .as_ref()
                    .map(terminal_label)
                    .unwrap_or_else(|| "shell".into()),
                if space.online && pane.terminal.as_ref().is_some_and(|t| t.state == "live") {
                    Kind::Terminal
                } else {
                    Kind::Disabled
                },
            );
            row.address = Some(address.clone());
            row.meta = address.rsplit('/').next().unwrap_or("").into();
            row.status = pane.terminal.as_ref().and_then(terminal_status);
            rows.push(row);
            for child in &pane.children {
                let mut row = Row::new(
                    &child.address,
                    format!("↳ {}", terminal_label(child)),
                    if space.online && child.state == "live" {
                        Kind::Terminal
                    } else {
                        Kind::Disabled
                    },
                );
                row.address = Some(child.address.clone());
                row.meta = child.address.rsplit('/').next().unwrap_or("").into();
                row.status = terminal_status(child);
                rows.push(row);
            }
        }
    }
    rows
}
fn matches(query: &str, values: &[&str]) -> bool {
    values
        .join(" ")
        .to_lowercase()
        .contains(&query.to_lowercase())
}

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Saved {
    view: String,
    scope: Option<String>,
    checkout: Option<String>,
    selected: Option<String>,
}
struct Picker {
    world: World,
    repos: Vec<Repository>,
    saved: Saved,
    query: String,
    search: Option<usize>,
    top: usize,
    message: String,
    help: bool,
    loading: bool,
    discovering: bool,
    discovered: bool,
    busy: bool,
}
impl Picker {
    fn new(saved: Saved) -> Self {
        Self {
            world: World {
                spaces: vec![],
                machines: vec![],
                terminals: vec![],
            },
            repos: vec![],
            saved,
            query: String::new(),
            search: None,
            top: 0,
            message: String::new(),
            help: false,
            loading: false,
            discovering: false,
            discovered: false,
            busy: false,
        }
    }
    fn spaces_view(&self) -> bool {
        self.saved.view == "spaces"
    }
    fn rows(&self) -> Vec<Row> {
        let scope = self.saved.scope.as_deref();
        if scope.is_none() {
            if self.spaces_view() {
                let mut rows = Vec::new();
                let mut machine = None;
                for s in &self.world.spaces {
                    let text = terminals(s)
                        .map(terminal_search)
                        .collect::<Vec<_>>()
                        .join(" ");
                    if !matches(&self.query, &[&s.name, &s.folder, &s.machine, &text]) {
                        continue;
                    }
                    if machine != Some(&s.machine) {
                        rows.push(Row::new(
                            format!("machine:{}", s.machine),
                            if s.machine.is_empty() {
                                "local"
                            } else {
                                &s.machine
                            },
                            Kind::Heading,
                        ));
                        machine = Some(&s.machine);
                    }
                    let mut r = Row::new(&s.id, &s.name, Kind::Space);
                    r.meta = if s.online {
                        terminals(s).count().to_string()
                    } else {
                        "offline".into()
                    };
                    r.status = rollup(terminals(s));
                    rows.push(r);
                }
                return rows;
            }
            let mut repos: Vec<_> = self.repos.iter().collect();
            repos.sort_by_key(|r| r.space_ids.is_empty());
            return repos
                .into_iter()
                .filter_map(|r| {
                    let branches = r
                        .checkouts
                        .iter()
                        .map(|c| {
                            format!("{} {}", c.path, c.branch.as_deref().unwrap_or("detached"))
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    let spaces: Vec<_> = self
                        .world
                        .spaces
                        .iter()
                        .filter(|s| r.space_ids.contains(&s.id))
                        .collect();
                    let text = spaces
                        .iter()
                        .map(|s| {
                            format!(
                                "{} {} {}",
                                s.name,
                                s.folder,
                                terminals(s)
                                    .map(terminal_search)
                                    .collect::<Vec<_>>()
                                    .join(" ")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join(" ");
                    if !matches(
                        &self.query,
                        &[&r.name, &r.folder, &r.machine, &branches, &text],
                    ) {
                        return None;
                    }
                    let mut row = Row::new(&r.id, &r.name, Kind::Repository);
                    row.meta = if !r.online {
                        "offline"
                    } else if r.machine.is_empty() {
                        "local"
                    } else {
                        &r.machine
                    }
                    .into();
                    row.status = rollup(spaces.into_iter().flat_map(terminals));
                    Some(row)
                })
                .collect();
        }
        let repo = self.repos.iter().find(|r| Some(r.id.as_str()) == scope);
        let space = self
            .world
            .spaces
            .iter()
            .find(|s| Some(s.id.as_str()) == scope);
        let online = if self.spaces_view() {
            space.map(|s| s.online)
        } else {
            repo.map(|r| r.online)
        };
        let Some(online) = online else {
            return vec![];
        };
        let mut rows = Vec::new();
        for (action, label) in [
            ("opencode", "+ OpenCode"),
            ("shell", "+ Shell"),
            ("worktree", "+ Worktree"),
        ] {
            if (action == "worktree" && self.spaces_view()) || !matches(&self.query, &[label]) {
                continue;
            }
            let mut r = Row::new(
                format!("action:{action}"),
                label,
                if online { Kind::Action } else { Kind::Disabled },
            );
            r.action = Some(action);
            r.meta = if !online {
                "offline"
            } else if action == "worktree" {
                "new branch"
            } else {
                ""
            }
            .into();
            rows.push(r);
        }
        for s in &self.world.spaces {
            if if self.spaces_view() {
                Some(s.id.as_str()) != scope
            } else {
                !repo.is_some_and(|r| r.space_ids.contains(&s.id))
            } {
                continue;
            }
            let all = matches(&self.query, &[&s.name, &s.folder, &s.machine]);
            let entries: Vec<_> = session_rows(s)
                .into_iter()
                .filter(|r| {
                    r.kind != Kind::Heading
                        && (all
                            || matches(
                                &self.query,
                                &[&r.label, &r.meta, r.address.as_deref().unwrap_or("")],
                            ))
                })
                .collect();
            if !entries.is_empty() {
                rows.push(Row::new(
                    format!("space-heading:{}", s.id),
                    &s.name,
                    Kind::Heading,
                ));
                rows.extend(entries);
            }
        }
        if !self.spaces_view()
            && let Some(r) = repo
            && r.checkouts.len() > 1
        {
            rows.push(Row::new(
                "checkouts",
                "Checkout · tap to use",
                Kind::Heading,
            ));
            for c in &r.checkouts {
                let branch = c.branch.as_deref().unwrap_or("detached");
                if !matches(&self.query, &[branch, &c.path]) {
                    continue;
                }
                let chosen = self.saved.checkout.as_deref().unwrap_or(&r.folder) == c.path;
                let mut row = Row::new(
                    format!("checkout:{}", c.path),
                    format!("{}{branch}", if chosen { "✓ " } else { "" }),
                    Kind::Checkout,
                );
                row.meta = c.path.rsplit('/').next().unwrap_or("").into();
                row.path = Some(c.path.clone());
                rows.push(row);
            }
        }
        rows
    }
    fn reconcile(&mut self) {
        if let Some(scope) = &self.saved.scope {
            let missing = if self.spaces_view() {
                !self.world.spaces.iter().any(|s| &s.id == scope)
            } else {
                self.discovered && !self.repos.iter().any(|r| &r.id == scope)
            };
            if missing {
                self.saved.scope = None;
                self.saved.checkout = None;
                self.top = 0;
            }
        }
        if !self.spaces_view() && !self.discovered {
            return;
        }
        if let Some(repo) = self
            .repos
            .iter()
            .find(|r| Some(&r.id) == self.saved.scope.as_ref())
            && self
                .saved
                .checkout
                .as_ref()
                .is_some_and(|p| !repo.checkouts.iter().any(|c| &c.path == p))
        {
            self.saved.checkout = None;
        }
        let rows = self.rows();
        if !rows
            .iter()
            .any(|r| Some(&r.id) == self.saved.selected.as_ref() && r.selectable())
        {
            self.saved.selected = rows.iter().find(|r| r.selectable()).map(|r| r.id.clone());
        }
    }
    fn visible(&mut self, height: usize) -> Vec<Row> {
        let rows = self.rows();
        let body = height.saturating_sub(4);
        if body == 0 {
            self.top = 0;
            return vec![];
        }
        if let Some(at) = rows
            .iter()
            .position(|r| Some(&r.id) == self.saved.selected.as_ref())
        {
            if at < self.top {
                self.top = at;
            } else if at >= self.top + body {
                self.top = at + 1 - body;
            }
        }
        self.top = self.top.min(rows.len().saturating_sub(body));
        rows.into_iter().skip(self.top).take(body).collect()
    }
    fn move_by(&mut self, delta: isize) {
        let rows: Vec<_> = self.rows().into_iter().filter(Row::selectable).collect();
        if rows.is_empty() {
            return;
        }
        let at = rows
            .iter()
            .position(|r| Some(&r.id) == self.saved.selected.as_ref())
            .unwrap_or(0);
        self.saved.selected = Some(
            rows[at.saturating_add_signed(delta).min(rows.len() - 1)]
                .id
                .clone(),
        );
    }
    fn back(&mut self) {
        if !self.query.is_empty() {
            self.query.clear();
        } else if let Some(scope) = self.saved.scope.take() {
            self.saved.selected = Some(scope);
            self.saved.checkout = None;
            self.top = 0;
        }
        self.reconcile();
    }
    fn switch(&mut self, spaces: bool) {
        self.saved.view = if spaces { "spaces" } else { "repos" }.into();
        self.saved.scope = None;
        self.saved.checkout = None;
        self.saved.selected = None;
        self.query.clear();
        self.top = 0;
        self.reconcile();
    }
    fn offline(&mut self) {
        for m in &mut self.world.machines {
            m.state = "unavailable".into();
        }
        for s in &mut self.world.spaces {
            s.online = false;
        }
        for r in &mut self.repos {
            r.online = false;
        }
    }
    fn connectivity(&mut self) {
        for r in &mut self.repos {
            r.online &= self
                .world
                .machines
                .iter()
                .any(|m| m.name == r.machine && m.state == "connected");
            r.space_ids = self
                .world
                .spaces
                .iter()
                .filter(|s| {
                    s.machine == r.machine
                        && r.checkouts
                            .iter()
                            .any(|c| c.path == *s.workspace_folder.as_ref().unwrap_or(&s.folder))
                })
                .map(|s| s.id.clone())
                .collect();
        }
    }
    fn screen(&mut self, width: usize, height: usize) -> Vec<String> {
        if height == 0 {
            return vec![];
        }
        if width < 12 || height < 6 {
            return vec![pad("Resize · q quit", width)];
        }
        let repo = self
            .repos
            .iter()
            .find(|r| Some(&r.id) == self.saved.scope.as_ref());
        let space = self
            .world
            .spaces
            .iter()
            .find(|s| Some(&s.id) == self.saved.scope.as_ref());
        let title = if self.saved.scope.is_none() {
            "herdr pocket".into()
        } else {
            format!(
                "‹ {}",
                if self.spaces_view() {
                    space.map(|s| s.name.as_str()).unwrap_or("Space")
                } else {
                    repo.map(|r| r.name.as_str()).unwrap_or("Repository")
                }
            )
        };
        let context = if self.saved.scope.is_none() {
            "tap a workspace · Tab switches view"
        } else if self.spaces_view() {
            space.map(|s| s.folder.as_str()).unwrap_or("")
        } else {
            repo.map(|r| {
                r.checkouts
                    .iter()
                    .find(|c| c.path == *self.saved.checkout.as_ref().unwrap_or(&r.folder))
                    .and_then(|c| c.branch.as_deref())
                    .unwrap_or(self.saved.checkout.as_deref().unwrap_or(&r.folder))
            })
            .unwrap_or("")
        };
        let mut lines = vec![
            format!("\x1b[1m{}\x1b[0m", pad(&title, width)),
            pad(
                if self.spaces_view() {
                    " Repos   [Spaces]"
                } else {
                    "[Repos]   Spaces"
                },
                width,
            ),
            pad(context, width),
        ];
        if self.help {
            lines.extend(
                [
                    "↑/↓ j/k   move",
                    "Enter / tap / 1–9   open",
                    "Tab   repos / spaces",
                    "Esc / h   back",
                    "/   search (Esc clears)",
                    "o / n   + OpenCode",
                    "s   + Shell",
                    "w   + Worktree",
                    "r   rediscover repos",
                    "q / Ctrl+C   quit",
                    "Terminal: Picker / Ctrl+] / Ctrl+\\",
                    "Sessions keep running.",
                ]
                .iter()
                .take(height - 4)
                .map(|s| pad(s, width)),
            );
        } else {
            let rows = self.visible(height);
            let mut shortcut = 0;
            for r in &rows {
                let number = if r.selectable() && shortcut < 9 {
                    shortcut += 1;
                    Some(shortcut)
                } else {
                    None
                };
                lines.push(row_line(
                    r,
                    Some(&r.id) == self.saved.selected.as_ref(),
                    width,
                    number,
                ));
            }
            if rows.is_empty() {
                lines.push(pad(
                    if self.loading || self.discovering {
                        "Finding workspaces…"
                    } else if !self.query.is_empty() {
                        "No matches · Esc clears search"
                    } else if self.saved.scope.is_some() {
                        "No sessions yet"
                    } else if self.spaces_view() {
                        "No spaces yet · r refresh"
                    } else {
                        "No repos found · Spaces or r refresh"
                    },
                    width,
                ));
            }
        }
        lines.resize(height - 1, " ".repeat(width));
        lines.truncate(height - 1);
        let footer = if self.search.is_some() {
            format!("Find: {}", self.query)
        } else if !self.message.is_empty() {
            self.message.clone()
        } else if self.busy {
            "Opening…".into()
        } else if self.discovering {
            "Discovering repos…".into()
        } else if !self.query.is_empty() {
            format!("/ {}", self.query)
        } else {
            "1–9 open  / find  Tab view  ? help".into()
        };
        lines.push(if let Some(cursor) = self.search {
            search_line(&self.query, cursor, width)
        } else {
            pad(&footer, width)
        });
        lines
    }
}
fn row_line(row: &Row, selected: bool, width: usize, shortcut: Option<usize>) -> String {
    if row.kind == Kind::Heading {
        return format!("\x1b[90m{}\x1b[0m", pad(&format!(" {}", row.label), width));
    }
    let meta = clip(&row.meta, 16.min(width / 3));
    let label = pad(&row.label, width.saturating_sub(meta.width() + 6));
    let dot = shortcut
        .map(|n| n.to_string())
        .unwrap_or_else(|| if row.status.is_some() { "●" } else { "·" }.into());
    let line = pad(
        &format!("{} {dot} {label} {meta}", if selected { "›" } else { " " }),
        width,
    );
    format!(
        "{}{}\x1b[0m",
        if selected {
            "\x1b[48;5;237m"
        } else if row.kind == Kind::Disabled {
            "\x1b[90m"
        } else {
            ""
        },
        line
    )
}

struct Screen(bool);
impl Screen {
    fn enter() -> Result<Self> {
        terminal::enable_raw_mode()?;
        let guard = Self(true);
        execute!(
            io::stdout(),
            EnterAlternateScreen,
            cursor::Hide,
            event::EnableMouseCapture,
            terminal::DisableLineWrap,
            Clear(ClearType::All)
        )?;
        Ok(guard)
    }
}
impl Drop for Screen {
    fn drop(&mut self) {
        if self.0 {
            let _ = execute!(
                io::stdout(),
                event::DisableMouseCapture,
                terminal::EnableLineWrap,
                cursor::Show,
                LeaveAlternateScreen
            );
            let _ = terminal::disable_raw_mode();
        }
    }
}
fn state_path() -> Option<PathBuf> {
    std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".local/state")))
        .map(|p| p.join("herdr-pocket-tui/view.json"))
}
fn save(saved: &Saved) {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let Some(path) = state_path() else {
        return;
    };
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(parent)
        .is_err()
    {
        return;
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)
    {
        let _ = serde_json::to_writer(&mut file, saved);
    }
}

struct Opened {
    address: String,
    title: String,
    checkout: Option<(String, String)>,
}
enum Reply {
    UpdateChecked(Option<String>),
    Updated(Result<()>),
    World(Result<World>),
    Repos(Result<Vec<Repository>>),
    Open(Result<Opened>),
}
fn refresh(backend: &Backend, tx: &mpsc::Sender<Reply>, picker: &mut Picker) {
    if picker.loading {
        return;
    }
    picker.loading = true;
    let backend = backend.clone();
    let tx = tx.clone();
    thread::spawn(move || {
        let _ = tx.send(Reply::World(backend.world()));
    });
}
fn discover(backend: &Backend, tx: &mpsc::Sender<Reply>, picker: &mut Picker, force: bool) {
    if picker.discovering {
        return;
    }
    picker.discovering = true;
    let backend = backend.clone();
    let tx = tx.clone();
    let world = picker.world.clone();
    thread::spawn(move || {
        let _ = tx.send(Reply::Repos(backend.repositories(&world, force)));
    });
}
fn launch(backend: &Backend, tx: &mpsc::Sender<Reply>, picker: &mut Picker, action: &'static str) {
    if picker.busy {
        return;
    }
    let Some(scope) = picker.saved.scope.clone() else {
        picker.message = "Choose a repository or space first".into();
        return;
    };
    let repo = picker.repos.iter().find(|r| r.id == scope).cloned();
    let space = picker.world.spaces.iter().find(|s| s.id == scope).cloned();
    let spaces = picker.spaces_view();
    let online = if spaces {
        space.as_ref().is_some_and(|s| s.online)
    } else {
        repo.as_ref().is_some_and(|r| r.online)
    };
    if !online {
        picker.message = "Machine offline".into();
        return;
    }
    if spaces && action == "worktree" {
        picker.message = "Choose a repository for a worktree".into();
        return;
    }
    picker.busy = true;
    let checkout = picker.saved.checkout.clone();
    let backend = backend.clone();
    let tx = tx.clone();
    thread::spawn(move || {
        let result = if spaces {
            let s = space.unwrap();
            backend.launch(Launch {
                machine: s.machine,
                space: Some(s.id),
                folder: Some(s.folder),
                program: action.into(),
                ..Default::default()
            })
        } else {
            let r = repo.unwrap();
            if action == "worktree" {
                backend.new_repository_worktree(&r, "opencode")
            } else {
                backend.launch_in_repository(&r, action, checkout.as_deref())
            }
        };
        let _ = tx.send(Reply::Open(result.map(|c| {
            Opened {
                address: c.address,
                title: if action == "shell" {
                    "Shell"
                } else {
                    "OpenCode"
                }
                .into(),
                checkout: if action == "worktree" {
                    Some((scope, c.folder))
                } else {
                    None
                },
            }
        })));
    });
}

/// Run until quit or the process-wide stop flag is set. In-flight RPC workers
/// are deliberately not joined: a dead host must not prevent terminal cleanup.
pub fn run(backend: Backend, stop: Arc<AtomicBool>) -> Result<()> {
    let saved = state_path()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let mut picker = Picker::new(saved);
    let (tx, rx) = mpsc::channel();
    let result = run_picker(&backend, &stop, &tx, &rx, &mut picker);
    save(&picker.saved);
    let (closed_tx, closed_rx) = mpsc::channel();
    thread::spawn(move || {
        backend.close();
        let _ = closed_tx.send(());
    });
    // Allow normal socket cleanup to finish without waiting on an RPC worker
    // which might still hold the backend's connection mutex.
    let _ = closed_rx.recv_timeout(Duration::from_millis(100));
    result
}
fn run_picker(
    backend: &Backend,
    stop: &Arc<AtomicBool>,
    tx: &mpsc::Sender<Reply>,
    rx: &mpsc::Receiver<Reply>,
    picker: &mut Picker,
) -> Result<()> {
    let mut screen = Some(Screen::enter()?);
    // On Linux current_exe points to a deleted inode after atomic replacement.
    let restart_executable = std::env::current_exe()?;
    let update_tx = tx.clone();
    thread::spawn(move || {
        let _ = update_tx.send(Reply::UpdateChecked(crate::updater::check().ok().flatten()));
    });
    let mut update_revision = None;
    let mut updating = false;
    let mut updated = false;
    let mut update_error = false;
    let mut next_world = Instant::now();
    let mut next_discovery = Instant::now();
    let mut want_discovery = true;
    let mut force_discovery = false;
    let mut last_screen = None;
    while !stop.load(Ordering::SeqCst) {
        let mut attach = None;
        while let Ok(reply) = rx.try_recv() {
            match reply {
                Reply::UpdateChecked(revision) => update_revision = revision,
                Reply::Updated(result) => {
                    updating = false;
                    match result {
                        Ok(()) => updated = true,
                        Err(error) => {
                            update_error = true;
                            picker.message = format!("Update failed: {error}");
                        }
                    }
                }
                Reply::World(result) => {
                    picker.loading = false;
                    match result {
                        Ok(world) => {
                            if world.machines.iter().any(|m| {
                                m.state == "connected"
                                    && picker
                                        .world
                                        .machines
                                        .iter()
                                        .any(|old| old.name == m.name && old.state != "connected")
                            }) {
                                want_discovery = true;
                                force_discovery = true;
                            }
                            picker.world = world;
                            picker.connectivity();
                        }
                        Err(e) => {
                            picker.message = e.to_string();
                            picker.offline();
                        }
                    }
                    if want_discovery && !picker.discovering {
                        discover(backend, tx, picker, force_discovery);
                        want_discovery = false;
                        force_discovery = false;
                        next_discovery = Instant::now() + Duration::from_secs(60);
                    }
                    picker.reconcile();
                }
                Reply::Repos(result) => {
                    picker.discovering = false;
                    match result {
                        Ok(repos) => {
                            picker.repos = repos;
                            picker.discovered = true;
                            picker.connectivity();
                        }
                        Err(e) => {
                            picker.message = e.to_string();
                            for r in &mut picker.repos {
                                r.online = false;
                            }
                        }
                    }
                    picker.reconcile();
                }
                Reply::Open(result) => {
                    picker.busy = false;
                    match result {
                        Ok(Opened {
                            address,
                            title,
                            checkout,
                        }) => {
                            if let Some((scope, folder)) = checkout {
                                if let Some(repo) = picker.repos.iter_mut().find(|r| r.id == scope)
                                    && !repo.checkouts.iter().any(|c| c.path == folder)
                                {
                                    repo.checkouts.push(crate::model::Checkout {
                                        path: folder.clone(),
                                        branch: None,
                                    });
                                }
                                if picker.saved.scope.as_ref() == Some(&scope) {
                                    picker.saved.checkout = Some(folder);
                                }
                                want_discovery = true;
                                force_discovery = true;
                            }
                            attach = Some((address, title));
                        }
                        Err(e) => picker.message = e.to_string(),
                    }
                }
            }
        }
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if let Some((address, title)) = attach {
            drop(screen.take());
            let seen_backend = backend.clone();
            let seen_address = address.clone();
            thread::spawn(move || {
                let _ = seen_backend.seen(&seen_address);
            });
            let result = crate::terminal::attach(&address, &title, stop.clone());
            if stop.load(Ordering::SeqCst) {
                break;
            }
            screen = Some(Screen::enter()?);
            last_screen = None;
            if let Err(e) = result {
                picker.message = e.to_string();
            }
            next_world = Instant::now();
        }
        if Instant::now() >= next_discovery {
            want_discovery = true;
        }
        if Instant::now() >= next_world {
            refresh(backend, tx, picker);
            next_world = Instant::now() + Duration::from_secs(2);
        }
        let (width, height) = terminal::size().unwrap_or((80, 24));
        let mut lines = picker.screen(width as usize, height as usize);
        if width >= 12 && height >= 6 && update_revision.is_some() {
            let label = if updated {
                "[u Restart] Update installed"
            } else if updating {
                "Updating… building Rust binary"
            } else if update_error {
                "[u Retry update] See error below"
            } else {
                "[u Update] New Pocket available"
            };
            lines[2] = format!("\x1b[1;36m{}\x1b[0m", pad(label, width as usize));
        }
        let rendered = (width, height, lines);
        if last_screen.as_ref() != Some(&rendered) {
            let mut stdout = io::stdout().lock();
            if last_screen
                .as_ref()
                .is_none_or(|(w, h, _)| *w != width || *h != height)
            {
                execute!(stdout, Clear(ClearType::All))?;
            }
            for (y, line) in rendered.2.iter().enumerate() {
                execute!(stdout, cursor::MoveTo(0, y as u16))?;
                write!(stdout, "{line}\x1b[0m\x1b[K")?;
            }
            stdout.flush()?;
            last_screen = Some(rendered);
        }
        if !event::poll(Duration::from_millis(50))? {
            continue;
        }
        let event = event::read()?;
        if let Event::Key(key) = event {
            if key.kind == KeyEventKind::Release {
                continue;
            }
            if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL)
                || picker.search.is_none() && key.code == KeyCode::Char('q')
            {
                break;
            }
        }
        if width < 12 || height < 6 {
            continue;
        }
        if let Event::Key(key) = event
            && picker.search.is_some()
        {
            edit_search(picker, key);
            continue;
        }
        if picker.help {
            picker.help = false;
            continue;
        }
        let update_pressed = matches!(event, Event::Key(key) if key.code == KeyCode::Char('u'))
            || matches!(event, Event::Mouse(mouse) if mouse.row == 2 && mouse.kind == MouseEventKind::Down(MouseButton::Left));
        if update_pressed && let Some(revision) = update_revision.as_ref() {
            if updated {
                use std::os::unix::process::CommandExt;
                save(&picker.saved);
                drop(screen.take());
                backend.close();
                let error = std::process::Command::new(&restart_executable).exec();
                return Err(error.into());
            }
            if !updating {
                updating = true;
                update_error = false;
                picker.message.clear();
                let revision = revision.clone();
                let tx = tx.clone();
                thread::spawn(move || {
                    let _ = tx.send(Reply::Updated(crate::updater::install(&revision)));
                });
            }
            continue;
        }
        let mut row = None;
        let mut action = None;
        match event {
            Event::Key(key) => match key.code {
                KeyCode::Up | KeyCode::Char('k') => picker.move_by(-1),
                KeyCode::Down | KeyCode::Char('j') => picker.move_by(1),
                KeyCode::PageUp => picker.move_by(-8),
                KeyCode::PageDown => picker.move_by(8),
                KeyCode::Esc | KeyCode::Left | KeyCode::Char('h') => picker.back(),
                KeyCode::Tab | KeyCode::BackTab => picker.switch(!picker.spaces_view()),
                KeyCode::Char('?') => picker.help = true,
                KeyCode::Char('/') => {
                    picker.search = Some(picker.query.chars().count());
                    picker.message.clear();
                }
                KeyCode::Char('r') => {
                    want_discovery = true;
                    force_discovery = true;
                    refresh(backend, tx, picker);
                }
                KeyCode::Char('o' | 'n') => action = Some("opencode"),
                KeyCode::Char('s') => action = Some("shell"),
                KeyCode::Char('w') => action = Some("worktree"),
                KeyCode::Char(c @ '1'..='9') => {
                    row = picker
                        .visible(height as usize)
                        .into_iter()
                        .filter(Row::selectable)
                        .nth(c as usize - '1' as usize)
                }
                KeyCode::Enter | KeyCode::Right | KeyCode::Char('l') => {
                    row = picker
                        .rows()
                        .into_iter()
                        .find(|r| Some(&r.id) == picker.saved.selected.as_ref())
                }
                _ => {}
            },
            Event::Mouse(mouse) => match mouse.kind {
                MouseEventKind::ScrollUp => picker.move_by(-1),
                MouseEventKind::ScrollDown => picker.move_by(1),
                MouseEventKind::Down(MouseButton::Left) => {
                    if mouse.row == 0 && picker.saved.scope.is_some() {
                        picker.back();
                    } else if mouse.row == 1 {
                        picker.switch(mouse.column >= 8);
                    } else if mouse.row >= 3 && mouse.row < height.saturating_sub(1) {
                        row = picker
                            .visible(height as usize)
                            .get((mouse.row - 3) as usize)
                            .cloned();
                    }
                }
                _ => {}
            },
            _ => {}
        }
        if let Some(row) = row.filter(Row::selectable) {
            picker.message.clear();
            picker.saved.selected = Some(row.id.clone());
            match row.kind {
                Kind::Repository | Kind::Space => {
                    picker.saved.scope = Some(row.id);
                    picker.saved.selected = None;
                    picker.saved.checkout = None;
                    picker.top = 0;
                    picker.query.clear();
                    picker.reconcile();
                }
                Kind::Checkout => picker.saved.checkout = row.path,
                Kind::Action => action = row.action,
                Kind::Terminal if !picker.busy => {
                    if let Some(address) = row.address {
                        // Feed attachment through the same reply path as launches.
                        let _ = tx.send(Reply::Open(Ok(Opened {
                            address,
                            title: row.label,
                            checkout: None,
                        })));
                    }
                }
                _ => {}
            }
        }
        if let Some(action) = action {
            launch(backend, tx, picker, action);
        }
    }
    drop(screen);
    Ok(())
}
fn edit_search(picker: &mut Picker, key: KeyEvent) {
    let mut chars: Vec<_> = picker.query.chars().collect();
    let mut at = picker.search.unwrap_or(0).min(chars.len());
    match key.code {
        KeyCode::Esc => {
            picker.search = None;
            picker.query.clear();
            picker.reconcile();
            return;
        }
        KeyCode::Enter => {
            picker.search = None;
            return;
        }
        KeyCode::Left => at = at.saturating_sub(1),
        KeyCode::Right => at = (at + 1).min(chars.len()),
        KeyCode::Home => at = 0,
        KeyCode::End => at = chars.len(),
        KeyCode::Backspace if at > 0 => {
            at -= 1;
            chars.remove(at);
        }
        KeyCode::Delete if at < chars.len() => {
            chars.remove(at);
        }
        KeyCode::Char(c)
            if !key
                .modifiers
                .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            chars.insert(at, c);
            at += 1;
        }
        _ => {}
    }
    picker.query = chars.into_iter().collect();
    picker.search = Some(at);
    picker.top = 0;
    picker.reconcile();
}

#[cfg(test)]
mod tests {
    use super::*;
    fn picker() -> Picker {
        let mut p = Picker::new(Saved::default());
        p.repos = serde_json::from_value(serde_json::json!([{"id":"repo", "name":"project", "machine":"", "folder":"/project", "commonDir":null, "checkouts":[{"path":"/project","branch":"main"},{"path":"/topic","branch":"topic"}], "spaceIds":["space"], "online":true}])).unwrap();
        p.world = serde_json::from_value(serde_json::json!({"machines":[{"name":"","state":"connected"}],"terminals":[],"spaces":[{"id":"space","localId":"space","name":"work","folder":"/project","machine":"","online":true,"tabs":[{"id":"tab","name":"main","panes":[{"id":"pane","address":"term","terminal":{"address":"term","state":"live","cwd":"/project","name":"editor","labels":{},"turn":0},"children":[{"address":"child","state":"live","cwd":"/project","name":"helper","labels":{},"turn":0}]},{"id":"panel","mod":"files","children":[]}]}]}]})).unwrap();
        p.discovered = true;
        p.reconcile();
        p
    }
    #[test]
    fn two_click_actions_and_sessions() {
        let mut p = picker();
        assert_eq!(p.rows()[0].kind, Kind::Repository);
        p.saved.scope = Some("repo".into());
        p.reconcile();
        let rows = p.rows();
        assert_eq!(
            &rows[..3]
                .iter()
                .map(|r| r.label.as_str())
                .collect::<Vec<_>>(),
            &["+ OpenCode", "+ Shell", "+ Worktree"]
        );
        assert!(
            rows.iter()
                .any(|r| r.address.as_deref() == Some("child") && r.selectable())
        );
        assert!(
            rows.iter()
                .any(|r| r.label.contains("desktop") && !r.selectable())
        );
        assert!(rows.iter().any(|r| r.path.as_deref() == Some("/topic")));
    }
    #[test]
    fn search_finds_nested_sessions_and_branches() {
        let mut p = picker();
        p.query = "helper".into();
        assert_eq!(p.rows().len(), 1);
        p.query = "topic".into();
        assert_eq!(p.rows().len(), 1);
        p.saved.scope = Some("repo".into());
        p.query = "helper".into();
        assert!(
            p.rows()
                .iter()
                .any(|r| r.address.as_deref() == Some("child"))
        );
        assert!(!p.rows().iter().any(|r| r.kind == Kind::Action));
    }
    #[test]
    fn offline_actions_and_terminals_cannot_open() {
        let mut p = picker();
        p.offline();
        p.saved.scope = Some("repo".into());
        assert!(
            p.rows()
                .iter()
                .filter(|r| r.action.is_some() || r.address.is_some())
                .all(|r| !r.selectable())
        );
    }
    #[test]
    fn tiny_render_and_unicode_are_bounded() {
        let mut p = picker();
        for width in 0..40 {
            for height in 0..10 {
                let lines = p.screen(width, height);
                assert!(lines.len() <= height);
                assert!(lines.iter().all(|s| clean(s).width() <= width));
            }
        }
        assert_eq!(clip("界界界", 4), "界…");
        assert_eq!(clip("e\u{301}x", 1), "…");
        assert_eq!(clean("a\x1b[2Jb\x1b]0;bad\x07c\n"), "abc");
        for cursor in 0..12 {
            let line = search_line("wide 界界 query", cursor, 12);
            assert!(clean(&line).width() <= 12);
        }
    }
    #[test]
    fn refresh_disables_stale_repositories_and_maps_worktrees() {
        let mut p = picker();
        p.world.spaces[0].folder = "/topic/subdir".into();
        p.world.spaces[0].workspace_folder = Some("/topic".into());
        p.connectivity();
        assert_eq!(p.repos[0].space_ids, vec!["space"]);
        p.world.machines[0].state = "disconnected".into();
        p.connectivity();
        assert!(!p.repos[0].online);
        p.saved.scope = Some("repo".into());
        p.saved.checkout = Some("/removed".into());
        p.reconcile();
        assert!(p.saved.checkout.is_none());
    }
    #[test]
    fn scrolling_uses_visible_selectable_rows() {
        let mut p = picker();
        p.saved.scope = Some("repo".into());
        p.reconcile();
        p.move_by(99);
        let rows = p.visible(6);
        assert!(
            rows.iter()
                .any(|r| Some(&r.id) == p.saved.selected.as_ref())
        );
        assert!(rows.len() <= 2);
        p.switch(true);
        assert_eq!(p.rows().iter().filter(|r| r.selectable()).count(), 1);
    }
}
