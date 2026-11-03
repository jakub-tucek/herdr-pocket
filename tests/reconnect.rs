#[test]
fn picker_disables_offline_actions_and_rediscovers_on_reconnect() {
    let output = std::process::Command::new("python3")
        .arg(format!("{}/tests/reconnect.py", env!("CARGO_MANIFEST_DIR")))
        .arg(env!("CARGO_BIN_EXE_herdr-pocket"))
        .output()
        .expect("run Python PTY reconnect test");
    assert!(
        output.status.success(),
        "PTY reconnect test failed:\n{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
