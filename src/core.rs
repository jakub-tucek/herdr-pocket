use anyhow::{Result, anyhow};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fmt,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::Duration,
};

#[derive(Debug, Clone)]
pub struct RpcError {
    pub message: String,
    pub kind: Option<String>,
}
impl fmt::Display for RpcError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for RpcError {}
pub fn hc_binary() -> PathBuf {
    if let Some(bin) = std::env::var_os("HC_BIN") {
        return bin.into();
    }
    if let Some(home) = std::env::var_os("HOME") {
        let bin = PathBuf::from(home).join(".local/bin/hc");
        if bin.exists() {
            return bin;
        }
    }
    "hc".into()
}
type Reply = std::result::Result<Value, RpcError>;
struct Shared {
    closed: AtomicBool,
    pending: Mutex<HashMap<u64, mpsc::Sender<Reply>>>,
    child: Mutex<Option<Child>>,
}
impl Shared {
    fn disconnect(&self, message: &str) {
        self.closed.store(true, Ordering::SeqCst);
        for (_, sender) in self.pending.lock().unwrap().drain() {
            let _ = sender.send(Err(RpcError {
                message: message.into(),
                kind: None,
            }));
        }
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
pub struct Core {
    shared: Arc<Shared>,
    stdin: Mutex<Option<ChildStdin>>,
    next: AtomicU64,
}
impl Core {
    pub fn new() -> Result<Self> {
        Self::with_binary(hc_binary())
    }
    pub fn with_binary(bin: impl AsRef<Path>) -> Result<Self> {
        Self::with_command(Command::new(bin.as_ref()))
    }
    /// Command injection supports isolated protocol tests without touching the user's core.
    pub fn with_command(mut command: Command) -> Result<Self> {
        let mut child = command
            .arg("connect")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("Missing hc stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("Missing hc stdout"))?;
        let shared = Arc::new(Shared {
            closed: AtomicBool::new(false),
            pending: Mutex::new(HashMap::new()),
            child: Mutex::new(Some(child)),
        });
        let reader = shared.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let value = match line
                    .ok()
                    .and_then(|l| serde_json::from_str::<Value>(&l).ok())
                {
                    Some(v) => v,
                    None => {
                        reader.disconnect("Invalid hc response");
                        return;
                    }
                };
                let Some(id) = value["id"].as_u64() else {
                    continue;
                };
                let sender = reader.pending.lock().unwrap().remove(&id);
                if let Some(sender) = sender {
                    let reply = if value.get("error").is_some_and(|e| !e.is_null()) {
                        Err(RpcError {
                            message: value["error"]["message"]
                                .as_str()
                                .unwrap_or("RPC failed")
                                .into(),
                            kind: value["error"]["data"]["kind"].as_str().map(String::from),
                        })
                    } else {
                        Ok(value["result"].clone())
                    };
                    let _ = sender.send(reply);
                }
            }
            reader.disconnect("hc connection closed");
        });
        let core = Self {
            shared,
            stdin: Mutex::new(Some(stdin)),
            next: AtomicU64::new(0),
        };
        core.rpc("hello", json!({"generation":1}))?;
        Ok(core)
    }
    pub fn is_closed(&self) -> bool {
        self.shared.closed.load(Ordering::SeqCst)
    }
    pub fn rpc(&self, method: &str, params: Value) -> Result<Value> {
        self.rpc_timeout(method, params, Duration::from_secs(12))
    }
    pub fn rpc_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        {
            let mut pending = self.shared.pending.lock().unwrap();
            if self.is_closed() {
                return Err(anyhow!("hc connection closed"));
            }
            pending.insert(id, tx);
        }
        let write = (|| -> Result<()> {
            let mut stdin = self.stdin.lock().unwrap();
            let stdin = stdin
                .as_mut()
                .ok_or_else(|| anyhow!("hc connection closed"))?;
            serde_json::to_writer(
                &mut *stdin,
                &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
            )?;
            stdin.write_all(b"\n")?;
            stdin.flush()?;
            Ok(())
        })();
        if let Err(error) = write {
            self.close();
            return Err(error);
        }
        match rx.recv_timeout(timeout) {
            Ok(reply) => reply.map_err(Into::into),
            Err(error) => {
                self.shared.pending.lock().unwrap().remove(&id);
                Err(anyhow!("Timed out or disconnected: {method}: {error}"))
            }
        }
    }
    pub fn close(&self) {
        self.shared.disconnect("Disconnected");
        self.stdin.lock().unwrap().take();
    }
}
impl Drop for Core {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mock() -> Core {
        let mut command = Command::new("python3");
        command.args(["-u","-c", "import sys,json\nfor line in sys.stdin:\n r=json.loads(line); m=r['method']\n if m=='wait': continue\n v={'id':r['id'],'result':r['params']}\n if m=='conflict': v={'id':r['id'],'error':{'message':'retry','data':{'kind':'conflict'}}}\n print(json.dumps(v),flush=True)"]);
        Core::with_command(command).unwrap()
    }
    #[test]
    fn concurrent_rpc_errors_timeout_close() {
        let core = Arc::new(mock());
        let workers: Vec<_> = (0..12)
            .map(|i| {
                let core = core.clone();
                thread::spawn(move || assert_eq!(core.rpc("echo", json!({"n":i})).unwrap()["n"], i))
            })
            .collect();
        for worker in workers {
            worker.join().unwrap();
        }
        let error = core.rpc("conflict", json!({})).unwrap_err();
        assert_eq!(
            error.downcast_ref::<RpcError>().unwrap().kind.as_deref(),
            Some("conflict")
        );
        assert!(
            core.rpc_timeout("wait", json!({}), Duration::from_millis(20))
                .is_err()
        );
        assert!(core.shared.pending.lock().unwrap().is_empty());
        core.close();
        core.close();
        assert!(core.rpc("echo", json!({})).is_err());
        assert!(core.shared.child.lock().unwrap().is_none());
    }
}
