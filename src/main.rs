mod backend;
mod core;
mod model;
mod terminal;
mod tui;
mod updater;

use anyhow::{Context, Result, bail};
use std::{
    collections::HashMap,
    io::{self, IsTerminal},
    sync::{Arc, atomic::AtomicBool},
};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error:#}");
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut options = HashMap::new();
    let mut command = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => {
                println!(
                    "herdr-pocket — mobile Herdr terminal\n\n  herdr-pocket                     repos, workspaces and sessions\n  herdr-pocket --list [--json]       shared sessions\n  herdr-pocket --repos [--json]      detected repositories/worktrees\n  herdr-pocket --attach <address>    open a live core terminal\n  herdr-pocket new [options]         new Shell/OpenCode session\n  herdr-pocket tree [options]        new branch/worktree + session\n\nOptions: --machine <name> --space <id> --folder <path> --name <name>\n         --program shell|opencode --repo <path> --branch <name> --base HEAD\n\nTerminal: pinned Picker/Esc/Tab/history; Ctrl+] returns to picker.\nTouch requires your SSH client to forward terminal mouse events."
                );
                return Ok(());
            }
            "--version" | "-V" => {
                println!("herdr-pocket {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            "--json" | "--list" | "--repos" => {
                options.insert(arg, String::new());
            }
            "--attach" | "--machine" | "--space" | "--folder" | "--name" | "--program"
            | "--repo" | "--branch" | "--base" => {
                let value = args
                    .next()
                    .with_context(|| format!("{arg} requires a value"))?;
                options.insert(arg, value);
            }
            "new" | "tree" if command.is_none() => command = Some(arg),
            _ => bail!("Unknown argument: {arg}"),
        }
    }
    let backend = backend::Backend::new();
    let stop = Arc::new(AtomicBool::new(false));
    for signal in [
        signal_hook::consts::SIGINT,
        signal_hook::consts::SIGTERM,
        signal_hook::consts::SIGHUP,
    ] {
        signal_hook::flag::register(signal, stop.clone())?;
    }
    let result = (|| -> Result<()> {
        if let Some(command) = command {
            let program = options
                .get("--program")
                .map(String::as_str)
                .unwrap_or("opencode");
            if !["shell", "opencode"].contains(&program) {
                bail!("Program must be shell or opencode");
            }
            let machine = options.get("--machine").cloned().unwrap_or_default();
            let mut folder = options.get("--folder").cloned();
            if command == "tree" {
                let repo = options.get("--repo").context("tree needs --repo")?;
                let branch = options.get("--branch").context("tree needs --branch")?;
                folder = Some(backend.new_worktree(
                    repo,
                    branch,
                    options.get("--base").map(String::as_str).unwrap_or("HEAD"),
                    &machine,
                )?);
            }
            let created = backend.launch(backend::Launch {
                machine,
                space: options.get("--space").cloned(),
                folder,
                name: options.get("--name").cloned(),
                program: program.into(),
                reuse_folder: false,
            })?;
            println!("{}", serde_json::to_string(&created)?);
        } else if let Some(address) = options.get("--attach") {
            if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
                bail!("Attach needs an interactive terminal");
            }
            let world = backend.world()?;
            if !world
                .terminals
                .iter()
                .any(|t| t.address == *address && t.state == "live")
            {
                bail!("Live terminal not found: {address}");
            }
            let _ = backend.seen(address);
            terminal::attach(address, address, stop.clone())?;
        } else if options.contains_key("--repos") {
            let world = backend.world()?;
            let repos = backend.repositories(&world, false)?;
            if options.contains_key("--json") {
                println!("{}", serde_json::to_string_pretty(&repos)?);
            } else {
                for repo in repos {
                    println!(
                        "{} / {}  {}  ({} worktrees)",
                        if repo.machine.is_empty() {
                            "Local"
                        } else {
                            &repo.machine
                        },
                        repo.name,
                        repo.folder,
                        repo.checkouts.len()
                    );
                }
            }
        } else if options.contains_key("--list")
            || options.contains_key("--json")
            || !io::stdin().is_terminal()
            || !io::stdout().is_terminal()
        {
            let world = backend.world()?;
            if options.contains_key("--json") {
                println!("{}", serde_json::to_string_pretty(&world)?);
            } else {
                for space in world.spaces {
                    println!(
                        "{} / {}",
                        if space.machine.is_empty() {
                            "Local"
                        } else {
                            &space.machine
                        },
                        space.name
                    );
                    for tab in space.tabs {
                        for pane in tab.panes {
                            println!(
                                "  {}  {}",
                                tab.name,
                                pane.address.as_deref().unwrap_or("[desktop panel]")
                            );
                        }
                    }
                }
            }
        } else {
            tui::run(backend.clone(), stop.clone())?;
        }
        Ok(())
    })();
    backend.close();
    result
}
