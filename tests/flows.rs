use std::process::Command;

#[test]
fn real_core_and_mobile_pty_workflows() {
    let output = Command::new("python3")
        .args(["tests/pty_smoke.py", env!("CARGO_BIN_EXE_herdr-pocket")])
        .output()
        .expect("Python 3 is needed for the real PTY integration test");
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    println!("{}", String::from_utf8_lossy(&output.stdout));
}
