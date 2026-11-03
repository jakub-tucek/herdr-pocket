//! Updates use a pinned main commit in a disposable checkout, never the user's repo.
use anyhow::{Context, Result, bail};
use std::{
    fs,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const REPO: &str = "https://github.com/jakub-tucek/herdr-pocket.git";
pub const REVISION: &str = env!("HERDR_POCKET_REVISION");

fn command(cmd: &mut Command, timeout: Duration) -> Result<String> {
    let log = tempfile::tempfile()?;
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log.try_clone()?)
        .env("GIT_TERMINAL_PROMPT", "0")
        .spawn()
        .context("Start updater command (git and cargo required)")?;
    let start = Instant::now();
    loop {
        if let Some(status) = child.try_wait()? {
            use std::io::{Read, Seek};
            let mut log = log;
            log.rewind()?;
            let mut output = String::new();
            log.read_to_string(&mut output)?;
            if !status.success() {
                bail!(
                    "{}",
                    output
                        .lines()
                        .rev()
                        .take(4)
                        .collect::<Vec<_>>()
                        .into_iter()
                        .rev()
                        .collect::<Vec<_>>()
                        .join(" ")
                );
            }
            return Ok(output);
        }
        if start.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            bail!("Update command timed out");
        }
        thread::sleep(Duration::from_millis(100));
    }
}

fn valid_revision(value: &str) -> bool {
    value.len() == 40 && value.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn check() -> Result<Option<String>> {
    if !valid_revision(REVISION) {
        return Ok(None);
    }
    let output = command(
        Command::new("git").args(["ls-remote", REPO, "refs/heads/main"]),
        Duration::from_secs(15),
    )?;
    let revision = output
        .split_whitespace()
        .next()
        .context("Missing remote revision")?;
    if !valid_revision(revision) {
        bail!("Invalid remote revision");
    }
    Ok((revision != REVISION).then(|| revision.to_owned()))
}

pub fn install(revision: &str) -> Result<()> {
    if !valid_revision(revision) {
        bail!("Invalid update revision");
    }
    let destination = std::env::current_exe()?.canonicalize()?;
    let checkout = tempfile::tempdir()?;
    let root = checkout.path();
    command(
        Command::new("git").args(["init", "--quiet"]).arg(root),
        Duration::from_secs(10),
    )?;
    command(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["fetch", "--depth=1", REPO, revision]),
        Duration::from_secs(120),
    )?;
    command(
        Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["checkout", "--detach", "FETCH_HEAD"]),
        Duration::from_secs(30),
    )?;
    command(
        Command::new("cargo")
            .current_dir(root)
            .args(["build", "--release", "--locked", "--target-dir", "target"])
            .env("HERDR_POCKET_REVISION", revision),
        Duration::from_secs(1800),
    )?;
    replace(&root.join("target/release/herdr-pocket"), &destination)?;
    Ok(())
}

fn replace(source: &std::path::Path, destination: &std::path::Path) -> Result<()> {
    let staged =
        tempfile::NamedTempFile::new_in(destination.parent().context("Binary has no parent")?)?;
    fs::copy(source, staged.path())?;
    fs::set_permissions(staged.path(), fs::metadata(source)?.permissions())?;
    staged.as_file().sync_all()?;
    staged
        .persist(destination)
        .map_err(|e| e.error)
        .context("Replace installed Pocket binary")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn replacement_preserves_old_binary_on_failure() {
        let dir = tempfile::tempdir().unwrap();
        let binary = dir.path().join("pocket");
        fs::write(&binary, "old").unwrap();
        assert!(replace(&dir.path().join("missing"), &binary).is_err());
        assert_eq!(fs::read_to_string(&binary).unwrap(), "old");
        let source = dir.path().join("new");
        fs::write(&source, "new").unwrap();
        replace(&source, &binary).unwrap();
        assert_eq!(fs::read_to_string(binary).unwrap(), "new");
    }
    #[test]
    fn rejects_non_commit_inputs() {
        for value in ["main", "--upload-pack=evil", "../foo", ""] {
            assert!(!valid_revision(value));
        }
        assert!(valid_revision(&"a".repeat(40)));
    }
}
