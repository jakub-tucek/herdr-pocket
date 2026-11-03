#[test]
fn update_prompt_retry_and_restart() {
    let output = std::process::Command::new("python3")
        .args(["tests/updater.py", env!("CARGO_BIN_EXE_herdr-pocket")])
        .output()
        .expect("Python 3 is needed for the updater PTY test");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
