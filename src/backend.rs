pub use crate::model::{Checkout, Repository};
use crate::{
    core::{Core, RpcError},
    model::{self, Machine, World, layout_doc, local_id, qualify},
};
use anyhow::{Result, anyhow, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Launch {
    pub machine: String,
    pub space: Option<String>,
    pub folder: Option<String>,
    pub name: Option<String>,
    pub program: String,
    pub reuse_folder: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Created {
    pub address: String,
    pub space: String,
    pub tab: String,
    pub folder: String,
}
#[derive(Clone)]
pub struct Backend {
    state: Arc<Mutex<State>>,
    discovery_lock: Arc<Mutex<()>>,
    init_lock: Arc<Mutex<()>>,
}
#[derive(Default)]
struct State {
    core: Option<Arc<Core>>,
    stopped: bool,
    layouts: HashMap<String, Value>,
    repositories: HashMap<String, Repository>,
    discovery: HashMap<String, Discovery>,
}
#[derive(Clone)]
struct Discovery {
    at: Instant,
    paths: Vec<String>,
    failed: bool,
}
struct Exec {
    code: Option<i64>,
    out: String,
    err: String,
}
fn id(prefix: &str) -> String {
    format!("{prefix}{}", uuid::Uuid::new_v4().simple())
}
fn on(machine: &str) -> Option<&str> {
    if machine.is_empty() {
        None
    } else {
        Some(machine)
    }
}
fn normalize(path: &str) -> String {
    let mut parts = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}
fn basename(path: &str) -> &str {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or("")
}
fn dirname(path: &str) -> &str {
    path.trim_end_matches('/')
        .rsplit_once('/')
        .map(|(p, _)| if p.is_empty() { "/" } else { p })
        .unwrap_or("/")
}
fn decode_base64(value: &Value) -> Result<String> {
    let input = value.as_str().unwrap_or_default();
    let mut bytes = Vec::new();
    let mut bits = 0u32;
    let mut count = 0;
    for byte in input.bytes().filter(|b| !b.is_ascii_whitespace()) {
        if byte == b'=' {
            break;
        }
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => bail!("Invalid base64 command output"),
        };
        bits = (bits << 6) | u32::from(digit);
        count += 6;
        if count >= 8 {
            count -= 8;
            bytes.push((bits >> count) as u8);
            bits &= (1 << count) - 1;
        }
    }
    Ok(String::from_utf8_lossy(&bytes).trim().into())
}
impl Default for Backend {
    fn default() -> Self {
        Self::new()
    }
}
impl Backend {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
            discovery_lock: Arc::new(Mutex::new(())),
            init_lock: Arc::new(Mutex::new(())),
        }
    }
    pub fn api(&self) -> Result<Arc<Core>> {
        self.api_with(|| Core::new().map(Arc::new))
    }
    fn api_with(&self, make_core: impl FnOnce() -> Result<Arc<Core>>) -> Result<Arc<Core>> {
        {
            let state = self.state.lock().unwrap();
            if state.stopped {
                bail!("Pocket client closed");
            }
            if let Some(core) = state.core.as_ref().filter(|c| !c.is_closed()) {
                return Ok(core.clone());
            }
        }
        // Only connection creators wait here. close() never acquires this lock.
        let _initializing = self.init_lock.lock().unwrap();
        {
            let state = self.state.lock().unwrap();
            if state.stopped {
                bail!("Pocket client closed");
            }
            if let Some(core) = state.core.as_ref().filter(|c| !c.is_closed()) {
                return Ok(core.clone());
            }
        }
        let core = make_core()?;
        let mut state = self.state.lock().unwrap();
        if state.stopped {
            drop(state);
            core.close();
            bail!("Pocket client closed");
        }
        state.core = Some(core.clone());
        Ok(core)
    }
    pub fn close(&self) {
        let core = {
            let mut state = self.state.lock().unwrap();
            state.stopped = true;
            state.core.take()
        };
        if let Some(core) = core {
            core.close();
        }
    }
    pub fn invalidate_repository_discovery(&self) {
        self.state.lock().unwrap().discovery.clear();
    }
    pub fn world(&self) -> Result<World> {
        let api = self.api()?;
        let (list, connected) = std::thread::scope(|scope| {
            let list = scope.spawn(|| api.rpc("terminal.list", json!({})));
            let connected = api.rpc("machine.list", json!({}));
            (list.join().unwrap(), connected)
        });
        let terminals: Vec<model::Terminal> = serde_json::from_value(list?["terminals"].clone())?;
        let mut remote: Vec<Machine> = serde_json::from_value(connected?["machines"].clone())?;
        remote.retain(|m| !m.temporary && !m.name.is_empty());
        remote.sort_by(|a, b| a.name.cmp(&b.name));
        let mut machines = vec![Machine {
            name: String::new(),
            state: "connected".into(),
            temporary: false,
        }];
        machines.extend(remote);
        let docs = std::thread::scope(|scope| {
            let requests: Vec<_> = machines
                .iter_mut()
                .map(|machine| {
                    let api = &api;
                    let terminals = &terminals;
                    scope.spawn(move || {
                        if machine.state == "connected" {
                            match api
                                .rpc(
                                    "doc.get",
                                    json!({"name":"herdr-app","on":on(&machine.name)}),
                                )
                                .and_then(|r| layout_doc(r["value"].clone()))
                            {
                                Ok(doc) => {
                                    self.state
                                        .lock()
                                        .unwrap()
                                        .layouts
                                        .insert(machine.name.clone(), doc);
                                }
                                Err(_) => machine.state = "unavailable".into(),
                            }
                        }
                        let doc = self
                            .state
                            .lock()
                            .unwrap()
                            .layouts
                            .get(&machine.name)
                            .cloned()
                            .unwrap_or_else(|| json!({"spaces":[]}));
                        model::flatten(&doc, &machine.name, terminals, machine.state == "connected")
                    })
                })
                .collect();
            requests
                .into_iter()
                .map(|request| request.join().unwrap())
                .collect::<Vec<_>>()
        });
        let spaces = docs.into_iter().flatten().collect();
        Ok(World {
            spaces,
            machines,
            terminals,
        })
    }
    pub fn seen(&self, address: &str) -> Result<()> {
        let api = self.api()?;
        let terminal = api.rpc("terminal.get", json!({"terminal":address}))?;
        if terminal
            .get("status")
            .is_some_and(|v| !v.is_null() && v != false)
        {
            api.rpc(
                "terminal.label",
                json!({"terminal":address,"labels":{"herdr.seen":terminal["turn"].to_string()}}),
            )?;
        }
        Ok(())
    }
    fn exec(
        &self,
        argv: Vec<String>,
        machine: &str,
        allow_failure: bool,
        timeout: u64,
    ) -> Result<Exec> {
        let result = self.api()?.rpc_timeout(
            "machine.exec",
            json!({"argv":argv,"on":on(machine),"timeout":timeout}),
            Duration::from_secs(timeout + 10),
        )?;
        let out = decode_base64(&result["stdout"])?;
        let err = decode_base64(&result["stderr"])?;
        if result["timed_out"] == true || result["truncated"] == true {
            bail!("Command timed out or output was truncated");
        }
        let code = result["code"].as_i64();
        if code != Some(0) && !allow_failure {
            bail!(
                "{}",
                if !err.is_empty() {
                    err.as_str()
                } else if !out.is_empty() {
                    out.as_str()
                } else {
                    "Command failed"
                }
            );
        }
        Ok(Exec { code, out, err })
    }
    fn command(
        &self,
        argv: &[&str],
        machine: &str,
        allow_failure: bool,
        timeout: u64,
    ) -> Result<Exec> {
        self.exec(
            argv.iter().map(|s| s.to_string()).collect(),
            machine,
            allow_failure,
            timeout,
        )
    }
    pub fn folder(&self, path: Option<&str>, machine: &str, timeout: u64) -> Result<String> {
        let mut path = path.unwrap_or_default().to_string();
        if path.is_empty() || path == "~" || path.starts_with("~/") {
            let home = self
                .command(&["printenv", "HOME"], machine, false, timeout)?
                .out;
            path = if let Some(relative) = path.strip_prefix("~/") {
                format!("{home}/{relative}")
            } else {
                home
            };
        }
        if !path.starts_with('/') || path.chars().any(|c| c <= '\u{1f}') {
            bail!("Use an absolute path or ~/path");
        }
        Ok(normalize(&path))
    }
    pub fn launch(&self, input: Launch) -> Result<Created> {
        if input.program != "shell" && input.program != "opencode" {
            bail!("Unknown program: {}", input.program);
        }
        let api = self.api()?;
        let machine = &input.machine;
        let mut space = match &input.space {
            Some(s) => local_id(s, machine)?.to_string(),
            None => id("sp"),
        };
        let tab = id("tb");
        let pane = id("p");
        let folder = self.folder(input.folder.as_deref(), machine, 60)?;
        let argv = if input.program == "opencode" {
            let shell = self.command(&["printenv", "SHELL"], machine, true, 60)?.out;
            let shell = if shell.is_empty() {
                "/bin/sh".to_string()
            } else {
                shell
            };
            Some(
                if ["sh", "bash", "zsh", "ksh"]
                    .iter()
                    .any(|s| shell.ends_with(&format!("/{s}")))
                {
                    vec![
                        shell.clone(),
                        "-lic".into(),
                        "\"$@\"; exec \"$0\" -li".into(),
                        shell,
                        "opencode".into(),
                    ]
                } else if shell.ends_with("/fish") {
                    vec![shell, "-lic".into(), "opencode; exec fish -il".into()]
                } else {
                    vec!["opencode".into()]
                },
            )
        } else {
            None
        };
        let mut params =
            json!({"cwd":folder,"on":on(machine),"keep":true,"no_parent":true,"no_notify":true});
        if let Some(argv) = argv {
            params["argv"] = json!(argv);
        }
        let terminal = api.rpc("terminal.run", params)?;
        let address = terminal["address"]
            .as_str()
            .ok_or_else(|| anyhow!("Missing terminal address"))?
            .to_string();
        let mut published = false;
        let result = (|| -> Result<Created> {
            let raw_address = local_id(&address, machine)?;
            for attempt in 0..5 {
                let current = api.rpc("doc.get", json!({"name":"herdr-app","on":on(machine)}))?;
                let mut doc = layout_doc(current["value"].clone())?;
                let entry = json!({"id":tab,"name":if input.space.is_some(){input.name.as_deref().unwrap_or("")}else{""},"root":{"id":tab,"type":"row","children":[{"id":pane,"type":"block","content":{"terminal":raw_address}}]}});
                let spaces = doc["spaces"].as_array_mut().unwrap();
                let index = if input.space.is_some() {
                    Some(
                        spaces
                            .iter()
                            .position(|s| s["id"] == space)
                            .ok_or_else(|| anyhow!("Space closed"))?,
                    )
                } else if input.reuse_folder {
                    spaces.iter().position(|s| {
                        s["folder"]
                            .as_str()
                            .is_some_and(|s| !s.is_empty() && normalize(s) == folder)
                    })
                } else {
                    None
                };
                if let Some(index) = index {
                    space = spaces[index]["id"].as_str().unwrap().to_string();
                    spaces[index]["tabs"].as_array_mut().unwrap().push(entry);
                } else {
                    spaces.push(json!({"id":space,"name":input.name.as_deref().unwrap_or(""),"folder":folder,"tabs":[entry]}));
                }
                match api.rpc("doc.set",json!({"name":"herdr-app","on":on(machine),"version":current["version"],"value":doc})) {
                    Ok(_)=>{published=true;break;},
                    Err(error) if attempt<4 && error.downcast_ref::<RpcError>().is_some_and(|e|e.kind.as_deref()==Some("conflict"))=>{},
                    Err(error)=>return Err(error),
                }
            }
            api.rpc(
                "terminal.label",
                json!({"terminal":address,"labels":{"herdr.space":space,"herdr.tab":tab}}),
            )?;
            Ok(Created {
                address: address.clone(),
                space: qualify(&space, machine),
                tab: qualify(&tab, machine),
                folder: folder.clone(),
            })
        })();
        if result.is_err() && !published {
            let _ = api.rpc("terminal.kill", json!({"terminal":address}));
        }
        result
    }
    pub fn repositories(&self, world: &World, force: bool) -> Result<Vec<Repository>> {
        // Serialize refreshes, while allowing unrelated RPC and close calls to proceed.
        let _refresh = self.discovery_lock.lock().unwrap();
        if force {
            self.invalidate_repository_discovery();
        }
        let batches = std::thread::scope(|scope| {
            let workers: Vec<_> = world
                .machines
                .iter()
                .map(|machine| scope.spawn(move || self.repositories_on(world, machine)))
                .collect();
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .collect::<Result<Vec<_>>>()
        })?;
        let mut results: Vec<_> = batches.into_iter().flatten().collect();
        results.sort_by(|a, b| {
            (&a.machine, &a.name, &a.folder).cmp(&(&b.machine, &b.name, &b.folder))
        });
        Ok(results)
    }
    fn repositories_on(&self, world: &World, machine: &Machine) -> Result<Vec<Repository>> {
        let mut results = Vec::new();
        let previous: Vec<_> = self
            .state
            .lock()
            .unwrap()
            .repositories
            .values()
            .filter(|r| r.machine == machine.name)
            .cloned()
            .collect();
        if machine.state != "connected" {
            results.extend(previous.into_iter().map(|mut r| {
                r.online = false;
                r
            }));
            return Ok(results);
        }
        let spaces: Vec<_> = world
            .spaces
            .iter()
            .filter(|s| s.machine == machine.name)
            .collect();
        let mut candidates = Vec::new();
        let mut unique = BTreeSet::new();
        let mut add = |path: &str| {
            if !path.is_empty() && unique.insert(path.to_string()) {
                candidates.push(path.to_string());
            }
        };
        for s in &spaces {
            if let Some(folder) = &s.workspace_folder {
                add(folder);
            }
            add(&s.folder);
        }
        for t in &world.terminals {
            let owner = t.address.split_once('/').map(|(m, _)| m).unwrap_or("");
            if owner == machine.name {
                add(&t.cwd);
                if let Some(cwd) = t.foreground.as_ref().and_then(|f| f.cwd.as_deref()) {
                    add(cwd);
                }
            }
        }
        let cached = self
            .state
            .lock()
            .unwrap()
            .discovery
            .get(&machine.name)
            .cloned();
        let discovery = if let Some(cached) =
            cached.filter(|d| d.at.elapsed() < Duration::from_secs(if d.failed { 10 } else { 60 }))
        {
            cached
        } else {
            let mut discovery = Discovery {
                at: Instant::now(),
                paths: Vec::new(),
                failed: false,
            };
            let scan = (|| -> Result<Exec> {
                let home = self.folder(Some("~"), &machine.name, 5)?;
                self.exec(
                    vec![
                        "find".into(),
                        format!("{home}/Projects"),
                        format!("{home}/projects"),
                        format!("{home}/src"),
                        "-maxdepth".into(),
                        "4".into(),
                        "(".into(),
                        "-name".into(),
                        ".git".into(),
                        "-print0".into(),
                        "-prune".into(),
                        ")".into(),
                        "-o".into(),
                        "(".into(),
                        "-type".into(),
                        "d".into(),
                        "(".into(),
                        "-name".into(),
                        "node_modules".into(),
                        "-o".into(),
                        "-name".into(),
                        ".*".into(),
                        ")".into(),
                        "-prune".into(),
                        ")".into(),
                    ],
                    &machine.name,
                    true,
                    5,
                )
            })();
            match scan {
                Ok(scan) => {
                    discovery.paths = scan
                        .out
                        .split('\0')
                        .filter(|p| !p.is_empty())
                        .take(64)
                        .map(|p| dirname(p).to_string())
                        .collect();
                    discovery.failed = scan.code != Some(0)
                        && scan
                            .err
                            .lines()
                            .any(|s| !s.is_empty() && !s.contains("No such file or directory"));
                }
                Err(_) => discovery.failed = true,
            }
            self.state
                .lock()
                .unwrap()
                .discovery
                .insert(machine.name.clone(), discovery.clone());
            discovery
        };
        for path in &discovery.paths {
            add(path);
        }
        let mut failed = discovery.failed || candidates.len() > 64;
        candidates.truncate(64);
        // Six bounded workers. Each candidate has a five-second remote command limit.
        let queue = Mutex::new(candidates.into_iter());
        let found = Mutex::new(Vec::new());
        type Enumeration = Arc<OnceLock<std::result::Result<Vec<Checkout>, String>>>;
        let enumerations: Mutex<HashMap<String, Enumeration>> = Mutex::new(HashMap::new());
        std::thread::scope(|scope| {
            for _ in 0..6 {
                let queue = &queue;
                let found = &found;
                let enumerations = &enumerations;
                let machine = &machine.name;
                scope.spawn(move || {
                    loop {
                        let path = queue.lock().unwrap().next();
                        let Some(path) = path else {
                            break;
                        };
                        let result = (|| -> Result<Option<(String, String, Vec<Checkout>)>> {
                            let path = self.folder(Some(&path), machine, 5)?;
                            let common = self.command(
                                &[
                                    "git",
                                    "-C",
                                    &path,
                                    "rev-parse",
                                    "--path-format=absolute",
                                    "--git-common-dir",
                                ],
                                machine,
                                true,
                                5,
                            )?;
                            if common.code != Some(0) {
                                return Ok(None);
                            }
                            let common = normalize(&common.out);
                            let enumeration = enumerations
                                .lock()
                                .unwrap()
                                .entry(common.clone())
                                .or_insert_with(|| Arc::new(OnceLock::new()))
                                .clone();
                            let checkouts = enumeration
                                .get_or_init(|| {
                                    self.worktrees(&path, machine, 5).map_err(|e| e.to_string())
                                })
                                .as_ref()
                                .map_err(|message| anyhow!("{message}"))?
                                .clone();
                            Ok(Some((path, common, checkouts)))
                        })();
                        let stop = result.is_err();
                        found.lock().unwrap().push(result);
                        if stop {
                            queue.lock().unwrap().by_ref().for_each(drop);
                            break;
                        }
                    }
                });
            }
        });
        let mut grouped: HashMap<String, Repository> = HashMap::new();
        for result in found.into_inner().unwrap() {
            let (path, common, checkouts) = match result {
                Ok(Some(v)) => v,
                Ok(None) => continue,
                Err(_) => {
                    failed = true;
                    continue;
                }
            };
            let key = serde_json::to_string(&[&machine.name, &common])?;
            if checkouts.is_empty() {
                continue;
            }
            let folder = checkouts
                .iter()
                .find(|c| normalize(&format!("{}/.git", c.path)) == common)
                .unwrap_or(&checkouts[0])
                .path
                .clone();
            let repo = grouped.entry(key.clone()).or_insert_with(|| Repository {
                id: key,
                name: basename(&folder).into(),
                machine: machine.name.clone(),
                folder,
                common_dir: Some(common),
                checkouts: checkouts.clone(),
                space_ids: Vec::new(),
                online: true,
            });
            for space in &spaces {
                if (space.workspace_folder.as_deref() == Some(&path)
                    || space.folder == path
                    || repo.checkouts.iter().any(|c| {
                        Some(c.path.as_str())
                            == space
                                .workspace_folder
                                .as_deref()
                                .or(Some(space.folder.as_str()))
                    }))
                    && !repo.space_ids.contains(&space.id)
                {
                    repo.space_ids.push(space.id.clone());
                }
            }
        }
        if failed {
            for mut old in previous.iter().cloned() {
                old.online = false;
                grouped.entry(old.id.clone()).or_insert(old);
            }
        }
        let mut state = self.state.lock().unwrap();
        for old in &previous {
            state.repositories.remove(&old.id);
        }
        for repo in grouped.into_values() {
            state.repositories.insert(repo.id.clone(), repo.clone());
            results.push(repo);
        }
        Ok(results)
    }
    pub fn launch_in_repository(
        &self,
        repo: &Repository,
        program: &str,
        checkout: Option<&str>,
    ) -> Result<Created> {
        if !repo.online {
            bail!("Repository machine is offline");
        }
        let folder = checkout.unwrap_or(&repo.folder);
        if folder != repo.folder && !repo.checkouts.iter().any(|c| c.path == folder) {
            bail!("Checkout does not belong to repository");
        }
        self.launch(Launch {
            machine: repo.machine.clone(),
            folder: Some(folder.into()),
            name: Some(basename(folder).into()),
            program: program.into(),
            reuse_folder: true,
            ..Default::default()
        })
    }
    pub fn new_repository_worktree(&self, repo: &Repository, program: &str) -> Result<Created> {
        if !repo.online {
            bail!("Repository machine is offline");
        }
        if program != "shell" && program != "opencode" {
            bail!("Unknown program: {program}");
        }
        let millis = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
        let branch = format!(
            "pocket/{}-{}",
            base36(millis),
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        );
        let folder = self.new_worktree(&repo.folder, &branch, "HEAD", &repo.machine)?;
        self.invalidate_repository_discovery();
        self.launch(Launch {
            machine: repo.machine.clone(),
            folder: Some(folder.clone()),
            name: Some(branch),
            program: program.into(),
            reuse_folder: true,
            ..Default::default()
        })
        .map_err(|error| anyhow!("{error}; checkout kept: {folder}"))
    }
    pub fn worktrees(&self, repo: &str, machine: &str, timeout: u64) -> Result<Vec<Checkout>> {
        let repo = self.folder(Some(repo), machine, timeout)?;
        let result = self.command(
            &["git", "-C", &repo, "worktree", "list", "--porcelain", "-z"],
            machine,
            false,
            timeout,
        )?;
        Ok(parse_worktrees(&result.out))
    }
    pub fn new_worktree(
        &self,
        repo: &str,
        branch: &str,
        base: &str,
        machine: &str,
    ) -> Result<String> {
        if !branch
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
            || !branch
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b))
        {
            bail!("Invalid branch name");
        }
        let repo = self.folder(Some(repo), machine, 60)?;
        self.command(
            &["git", "check-ref-format", "--branch", branch],
            machine,
            false,
            60,
        )?;
        let common = self
            .command(
                &[
                    "git",
                    "-C",
                    &repo,
                    "rev-parse",
                    "--path-format=absolute",
                    "--git-common-dir",
                ],
                machine,
                false,
                60,
            )?
            .out;
        let home = self.folder(Some("~"), machine, 60)?;
        let name = basename(if common.ends_with("/.git") {
            dirname(&common)
        } else {
            &common
        });
        let mut slug = String::new();
        let mut separator = false;
        for c in branch.chars() {
            if c.is_ascii_alphanumeric() || "._-".contains(c) {
                slug.push(c);
                separator = false;
            } else if !separator {
                slug.push('-');
                separator = true;
            }
        }
        let folder = normalize(&format!(
            "{home}/.herdr/worktrees/{name}/{}",
            slug.trim_matches('-')
        ));
        let exists = self.command(
            &[
                "git",
                "-C",
                &repo,
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ],
            machine,
            true,
            60,
        )?;
        if exists.code != Some(0) && exists.code != Some(1) {
            bail!(
                "{}",
                if exists.err.is_empty() {
                    "Cannot check branch"
                } else {
                    &exists.err
                }
            );
        }
        let commit = if exists.code == Some(0) {
            None
        } else {
            Some(
                self.command(
                    &[
                        "git",
                        "-C",
                        &repo,
                        "rev-parse",
                        "--verify",
                        "--end-of-options",
                        &format!("{}^{{commit}}", if base.is_empty() { "HEAD" } else { base }),
                    ],
                    machine,
                    false,
                    60,
                )?
                .out,
            )
        };
        let mut argv = vec!["git", "-C", &repo, "worktree", "add"];
        if commit.is_some() {
            argv.extend(["-b", branch]);
        }
        argv.extend(["--", &folder, commit.as_deref().unwrap_or(branch)]);
        self.command(&argv, machine, false, 60)?;
        Ok(self
            .command(
                &["git", "-C", &folder, "rev-parse", "--show-toplevel"],
                machine,
                false,
                60,
            )?
            .out)
    }
}
fn parse_worktrees(out: &str) -> Vec<Checkout> {
    out.split("\0\0")
        .filter_map(|record| {
            let fields: Vec<_> = record.split('\0').collect();
            if fields.contains(&"bare") || fields.iter().any(|f| f.starts_with("prunable")) {
                return None;
            }
            Some(Checkout {
                path: fields
                    .iter()
                    .find_map(|f| f.strip_prefix("worktree "))?
                    .into(),
                branch: fields
                    .iter()
                    .find_map(|f| f.strip_prefix("branch refs/heads/"))
                    .map(String::from),
            })
        })
        .collect()
}
fn base36(mut value: u128) -> String {
    let mut out = Vec::new();
    loop {
        out.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(value % 36) as usize] as char);
        value /= 36;
        if value == 0 {
            break;
        }
    }
    out.into_iter().rev().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_discovery_starts_all_machines_concurrently() {
        let mut command = std::process::Command::new("python3");
        command.args(["-u", "-c", r#"import sys,json,threading,base64
pending=[]
expired=False
timer=None
lock=threading.Lock()
def send(r,out='',failed=False):
 print(json.dumps({'id':r['id'],'result':{'stdout':base64.b64encode(out.encode()).decode(),'stderr':'','code':0,'timed_out':failed}}),flush=True)
def expire():
 global expired
 with lock:
  expired=True
  for r in pending: send(r,failed=True)
  pending.clear()
for line in sys.stdin:
 r=json.loads(line); m=r['method']
 with lock:
  if m=='inspect': print(json.dumps({'id':r['id'],'result':{'expired':expired}}),flush=True)
  elif m=='machine.exec' and r['params']['argv'][0]=='printenv':
   if expired: send(r,failed=True)
   else:
    pending.append(r)
    if timer is None:
     timer=threading.Timer(0.8,expire); timer.daemon=True; timer.start()
    if len(pending)==3:
     timer.cancel()
     for request in pending: send(request,'/isolated')
     pending.clear()
  else: send(r)
"#]);
        let backend = Backend::new();
        backend.state.lock().unwrap().core = Some(Arc::new(Core::with_command(command).unwrap()));
        let world = World {
            machines: ["", "a", "b"]
                .into_iter()
                .map(|name| Machine {
                    name: name.into(),
                    state: "connected".into(),
                    temporary: false,
                })
                .collect(),
            ..Default::default()
        };
        assert!(backend.repositories(&world, false).unwrap().is_empty());
        let inspect = backend.api().unwrap().rpc("inspect", json!({})).unwrap();
        assert_eq!(
            inspect["expired"], false,
            "repository discovery serialized machine requests"
        );
        backend.close();
    }
    #[test]
    fn world_reads_machine_documents_concurrently_in_machine_order() {
        let mut command = std::process::Command::new("python3");
        command.args(["-u", "-c", r#"import sys,json,threading
pending=[]
lock=threading.Lock()
expired=False
timer=None
def send(r,result=None,error=None):
 print(json.dumps({'id':r['id'], 'error' if error else 'result':error if error else result}),flush=True)
def expire():
 global expired
 with lock:
  expired=True
  for r in pending: send(r,error={'message':'document requests were serialized'})
  pending.clear()
for line in sys.stdin:
 r=json.loads(line); m=r['method']
 with lock:
  if m=='terminal.list': send(r,{'terminals':[]})
  elif m=='machine.list': send(r,{'machines':[{'name':'b','state':'connected'},{'name':'a','state':'connected'}]})
  elif m=='doc.get':
   if expired: send(r,error={'message':'document requests were serialized'})
   else:
    pending.append(r)
    if timer is None:
     timer=threading.Timer(0.8,expire); timer.daemon=True; timer.start()
    if len(pending)==3:
     timer.cancel()
     for request in reversed(pending):
      host=request['params'].get('on') or 'local'
      send(request,{'value':{'spaces':[{'id':host,'folder':'/repo','tabs':[]}]},'version':1})
     pending.clear()
  else: send(r,{})
"#]);
        let backend = Backend::new();
        backend.state.lock().unwrap().core = Some(Arc::new(Core::with_command(command).unwrap()));
        let world = backend.world().unwrap();
        assert!(world.machines.iter().all(|m| m.state == "connected"));
        assert_eq!(
            world
                .spaces
                .iter()
                .map(|s| s.id.as_str())
                .collect::<Vec<_>>(),
            vec!["local", "a/a", "b/b"]
        );
        backend.close();
    }
    #[test]
    fn close_does_not_wait_for_slow_hello_or_publish_cancelled_core() {
        let backend = Backend::new();
        let worker_backend = backend.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (created_tx, created_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            worker_backend.api_with(|| {
            let mut command = std::process::Command::new("python3");
            command.args(["-u", "-c", "import sys,json,time\nfor line in sys.stdin:\n r=json.loads(line)\n if r['method']=='hello': time.sleep(1)\n print(json.dumps({'id':r['id'],'result':{}}),flush=True)"]);
            started_tx.send(()).unwrap();
            let core = Arc::new(Core::with_command(command)?);
            created_tx.send(core.clone()).unwrap();
            Ok(core)
        })
        });
        started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (closed_tx, closed_rx) = std::sync::mpsc::channel();
        let closing_backend = backend.clone();
        let closer = std::thread::spawn(move || {
            closing_backend.close();
            closed_tx.send(()).unwrap();
        });
        let quick = closed_rx.recv_timeout(Duration::from_millis(250)).is_ok();
        // Always join and reap the fake connection, including when the regression returns.
        let initialization = worker.join().unwrap();
        closer.join().unwrap();
        let created = created_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            quick,
            "close waited for the hello RPC while holding the state mutex"
        );
        assert!(
            initialization.is_err(),
            "cancelled initialization published a connection"
        );
        assert!(created.is_closed());
        assert!(backend.state.lock().unwrap().core.is_none());
        assert!(backend.api().is_err());
    }
    fn mock_backend(fail: &str) -> Backend {
        let mut command = std::process::Command::new("python3");
        command.args(["-u","-c",r#"import sys,json
doc={'future':{'keep':True},'spaces':[{'id':'existing','name':'Repo','folder':'/repo','tabs':[],'future':42}]}
calls=[]
conflicts=0
fail=sys.argv[1]
for line in sys.stdin:
 r=json.loads(line); m=r['method']; p=r['params']; calls.append([m,p]); error=None; result={}
 if m=='terminal.run': result={'address':'remote/term'}
 elif m=='doc.get': result={'value':doc,'version':7}
 elif m=='doc.set':
  conflicts+=1
  if fail=='set': error={'message':'denied'}
  elif conflicts==1: error={'message':'retry','data':{'kind':'conflict'}}
  else: doc=p['value']
 elif m=='terminal.label' and fail=='label': error={'message':'label denied'}
 elif m=='inspect': result={'doc':doc,'calls':calls}
 response={'id':r['id']}
 response['error' if error else 'result']=error if error else result
 print(json.dumps(response),flush=True)
"#,fail]);
        let core = Arc::new(Core::with_command(command).unwrap());
        let backend = Backend::new();
        backend.state.lock().unwrap().core = Some(core);
        backend
    }
    #[test]
    fn repository_grouping_discovery_cache_force_and_failure() {
        let mut command = std::process::Command::new("python3");
        command.args(["-u","-c",r#"import sys,json,base64
calls=[]
failed=False
for line in sys.stdin:
 r=json.loads(line); m=r['method']; p=r['params']; result={}
 if m=='fail': failed=True
 elif m=='inspect': result={'calls':calls}
 elif m=='machine.exec':
  a=p['argv']; calls.append(a); out=''; code=0
  if a[0]=='printenv': out='/isolated'
  elif a[0]=='find': out='/repos/main/.git\0/repos/work/.git\0'
  elif 'worktree' in a: out='worktree /repos/main\0branch refs/heads/main\0\0worktree /repos/work\0branch refs/heads/task\0\0'
  else: out='/repos/main/.git'
  result={'stdout':base64.b64encode(out.encode()).decode(),'stderr':'','code':code,'timed_out':failed}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#]);
        let backend = Backend::new();
        backend.state.lock().unwrap().core = Some(Arc::new(Core::with_command(command).unwrap()));
        let world = World {
            machines: vec![Machine {
                name: "remote".into(),
                state: "connected".into(),
                temporary: false,
            }],
            spaces: vec![model::Space {
                id: "remote/space".into(),
                machine: "remote".into(),
                folder: "/repos/work".into(),
                ..Default::default()
            }],
            ..Default::default()
        };
        let repos = backend.repositories(&world, false).unwrap();
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].folder, "/repos/main");
        assert_eq!(repos[0].checkouts.len(), 2);
        assert_eq!(repos[0].space_ids, vec!["remote/space"]);
        let calls = backend.api().unwrap().rpc("inspect", json!({})).unwrap()["calls"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(
            calls
                .iter()
                .filter(|a| a.as_array().unwrap().contains(&json!("worktree")))
                .count(),
            1
        );
        backend.repositories(&world, false).unwrap();
        let calls = backend.api().unwrap().rpc("inspect", json!({})).unwrap()["calls"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(calls.iter().filter(|a| a[0] == "find").count(), 1);
        backend.repositories(&world, true).unwrap();
        let calls = backend.api().unwrap().rpc("inspect", json!({})).unwrap()["calls"]
            .as_array()
            .unwrap()
            .clone();
        assert_eq!(calls.iter().filter(|a| a[0] == "find").count(), 2);
        backend.api().unwrap().rpc("fail", json!({})).unwrap();
        let repos = backend.repositories(&world, true).unwrap();
        assert_eq!(repos.len(), 1);
        assert!(!repos[0].online);
        backend.close();
    }
    #[test]
    fn launch_retries_cas_preserves_fields_and_qualifies() {
        let backend = mock_backend("");
        let created = backend
            .launch(Launch {
                machine: "remote".into(),
                folder: Some("/repo".into()),
                program: "shell".into(),
                reuse_folder: true,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(created.space, "remote/existing");
        assert!(created.tab.starts_with("remote/tb"));
        let inspect = backend.api().unwrap().rpc("inspect", json!({})).unwrap();
        assert_eq!(inspect["doc"]["future"]["keep"], true);
        assert_eq!(inspect["doc"]["spaces"][0]["future"], 42);
        assert_eq!(
            inspect["doc"]["spaces"][0]["tabs"][0]["root"]["children"][0]["content"]["terminal"],
            "term"
        );
        let calls = inspect["calls"].as_array().unwrap();
        assert_eq!(calls.iter().filter(|c| c[0] == "doc.set").count(), 2);
        assert!(!calls.iter().any(|c| c[0] == "terminal.kill"));
        backend.close();
    }
    #[test]
    fn rollback_only_unpublished_terminal() {
        for fail in ["set", "label"] {
            let backend = mock_backend(fail);
            assert!(
                backend
                    .launch(Launch {
                        machine: "remote".into(),
                        folder: Some("/repo".into()),
                        program: "shell".into(),
                        ..Default::default()
                    })
                    .is_err()
            );
            let inspect = backend.api().unwrap().rpc("inspect", json!({})).unwrap();
            assert_eq!(
                inspect["calls"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|c| c[0] == "terminal.kill"),
                fail == "set"
            );
            backend.close();
        }
    }
    #[test]
    fn base64_handles_nul_and_unicode() {
        assert_eq!(decode_base64(&json!("YSBiAMOpAA==")).unwrap(), "a b\0é\0");
    }
    #[test]
    fn worktree_parser_handles_detached_spaces_prunable() {
        let out = "worktree /repo one\0HEAD abc\0branch refs/heads/main\0\0worktree /detached\0HEAD abc\0detached\0\0worktree /bare\0bare\0\0worktree /gone\0prunable gitdir missing\0\0";
        let trees = parse_worktrees(out);
        assert_eq!(trees.len(), 2);
        assert_eq!(trees[0].path, "/repo one");
        assert_eq!(trees[0].branch.as_deref(), Some("main"));
        assert!(trees[1].branch.is_none());
    }
    #[test]
    fn close_is_shared_and_never_reconnects() {
        let backend = Backend::new();
        let clone = backend.clone();
        backend.close();
        assert!(clone.api().is_err());
    }
    #[test]
    fn offline_repository_cache_survives() {
        let backend = Backend::new();
        let repo = Repository {
            id: "id".into(),
            machine: "remote".into(),
            online: true,
            ..Default::default()
        };
        backend
            .state
            .lock()
            .unwrap()
            .repositories
            .insert(repo.id.clone(), repo);
        let world = World {
            machines: vec![Machine {
                name: "remote".into(),
                state: "offline".into(),
                temporary: false,
            }],
            ..Default::default()
        };
        let repos = backend.repositories(&world, false).unwrap();
        assert_eq!(repos.len(), 1);
        assert!(!repos[0].online);
    }
    #[test]
    fn repository_validation_does_not_connect() {
        let backend = Backend::new();
        let mut repo = Repository::default();
        assert!(backend.launch_in_repository(&repo, "shell", None).is_err());
        repo.online = true;
        repo.folder = "/repo".into();
        assert!(
            backend
                .launch_in_repository(&repo, "shell", Some("/other"))
                .is_err()
        );
        assert!(backend.new_repository_worktree(&repo, "bad").is_err());
        assert!(backend.state.lock().unwrap().core.is_none());
    }
    #[test]
    fn paths_normalize_without_host_filesystem() {
        assert_eq!(normalize("/repo/../repo//work/."), "/repo/work");
        assert_eq!(normalize("/../../"), "/");
    }
}
