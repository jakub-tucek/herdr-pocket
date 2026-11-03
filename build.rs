use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=HERDR_POCKET_REVISION");
    println!("cargo:rerun-if-changed=.git/HEAD");
    if let Ok(output) = Command::new("git")
        .args(["rev-parse", "--git-path", "HEAD"])
        .output()
    {
        println!(
            "cargo:rerun-if-changed={}",
            String::from_utf8_lossy(&output.stdout).trim()
        );
    }
    if let Ok(output) = Command::new("git")
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
    {
        let reference = String::from_utf8_lossy(&output.stdout);
        if output.status.success() {
            println!("cargo:rerun-if-changed=.git/{}", reference.trim());
        }
    }
    let revision = std::env::var("HERDR_POCKET_REVISION")
        .ok()
        .or_else(|| {
            let output = Command::new("git")
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()?;
            output
                .status
                .success()
                .then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
        })
        .unwrap_or_default();
    println!("cargo:rustc-env=HERDR_POCKET_REVISION={revision}");
}
