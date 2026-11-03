use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Foreground {
    pub cwd: Option<String>,
    pub name: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TerminalStatus {
    pub state: Option<String>,
    pub title: Option<String>,
    pub app: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Terminal {
    pub address: String,
    pub state: String,
    pub cwd: String,
    pub title: Option<String>,
    pub name: Option<String>,
    pub foreground: Option<Foreground>,
    pub labels: HashMap<String, String>,
    pub status: Option<TerminalStatus>,
    pub turn: u64,
    pub parent: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Pane {
    pub id: String,
    pub address: Option<String>,
    #[serde(rename = "mod")]
    pub mod_name: Option<String>,
    pub terminal: Option<Terminal>,
    pub children: Vec<Terminal>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Tab {
    pub id: String,
    pub name: String,
    pub panes: Vec<Pane>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Space {
    pub id: String,
    pub local_id: String,
    pub name: String,
    pub folder: String,
    pub workspace_folder: Option<String>,
    pub machine: String,
    pub tabs: Vec<Tab>,
    pub online: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Checkout {
    pub path: String,
    pub branch: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Repository {
    pub id: String,
    pub name: String,
    pub machine: String,
    pub folder: String,
    pub common_dir: Option<String>,
    pub checkouts: Vec<Checkout>,
    pub space_ids: Vec<String>,
    pub online: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Machine {
    pub name: String,
    pub state: String,
    pub temporary: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct World {
    pub spaces: Vec<Space>,
    pub machines: Vec<Machine>,
    pub terminals: Vec<Terminal>,
}

pub fn qualify(id: &str, machine: &str) -> String {
    if machine.is_empty() {
        id.into()
    } else {
        format!("{machine}/{id}")
    }
}
pub fn local_id<'a>(id: &'a str, machine: &str) -> Result<&'a str> {
    if machine.is_empty() {
        return Ok(id);
    }
    id.strip_prefix(&format!("{machine}/"))
        .ok_or_else(|| anyhow::anyhow!("Wrong machine for this space"))
}
/// Keep the original JSON, including fields owned by other clients.
pub fn layout_doc(value: Value) -> Result<Value> {
    if value.is_null() {
        return Ok(json!({"spaces": []}));
    }
    if !value
        .get("spaces")
        .and_then(Value::as_array)
        .is_some_and(|spaces| {
            spaces
                .iter()
                .all(|s| s["id"].is_string() && s["tabs"].is_array())
        })
    {
        bail!("Unsupported Herdr layout; not changed");
    }
    Ok(value)
}
pub fn nodes(root: &Value) -> Vec<&Value> {
    let mut result = vec![root];
    if let Some(children) = root["children"].as_array() {
        for child in children {
            result.extend(nodes(child));
        }
    }
    result
}
pub type Status = &'static str;
pub fn status(terminal: Option<&Terminal>) -> Option<Status> {
    let t = terminal?;
    let state = t.status.as_ref()?.state.as_deref()?;
    match state {
        "working" => Some("working"),
        "blocked" | "error" => Some("blocked"),
        "" => None,
        _ => {
            let seen = t
                .labels
                .get("herdr.seen")
                .map(|s| {
                    if s.trim().is_empty() {
                        0.0
                    } else {
                        s.parse::<f64>().unwrap_or(f64::NAN)
                    }
                })
                .unwrap_or(-1.0);
            Some(if t.turn as f64 > seen { "done" } else { "idle" })
        }
    }
}
#[cfg(test)]
pub fn rollup(terminals: &[Terminal]) -> Option<Status> {
    ["blocked", "done", "working", "idle"]
        .into_iter()
        .find(|s| terminals.iter().any(|t| status(Some(t)) == Some(*s)))
}
fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().into()
}
pub fn flatten(doc: &Value, machine: &str, terminals: &[Terminal], online: bool) -> Vec<Space> {
    doc["spaces"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|s| {
            let tabs: Vec<Tab> = s["tabs"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .map(|(index, tab)| {
                    let panes = nodes(&tab["root"])
                        .into_iter()
                        .filter(|n| {
                            n["content"]["terminal"]
                                .as_str()
                                .is_some_and(|s| !s.is_empty())
                                || n["content"]["mod"].as_str().is_some_and(|s| !s.is_empty())
                        })
                        .map(|n| {
                            let address = n["content"]["terminal"]
                                .as_str()
                                .filter(|s| !s.is_empty())
                                .map(|s| qualify(s, machine));
                            Pane {
                                id: qualify(&text(&n["id"]), machine),
                                terminal: terminals
                                    .iter()
                                    .find(|t| Some(&t.address) == address.as_ref())
                                    .cloned(),
                                children: terminals
                                    .iter()
                                    .filter(|t| {
                                        address.is_some()
                                            && t.parent.as_ref() == address.as_ref()
                                            && t.state == "live"
                                    })
                                    .cloned()
                                    .collect(),
                                address,
                                mod_name: n["content"]["mod"].as_str().map(String::from),
                            }
                        })
                        .collect();
                    Tab {
                        id: qualify(&text(&tab["id"]), machine),
                        name: tab["name"]
                            .as_str()
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                            .unwrap_or_else(|| (index + 1).to_string()),
                        panes,
                    }
                })
                .collect();
            let first = tabs
                .iter()
                .flat_map(|t| &t.panes)
                .find_map(|p| p.terminal.as_ref());
            let folder = first
                .and_then(|t| {
                    t.foreground
                        .as_ref()
                        .and_then(|f| f.cwd.as_deref())
                        .filter(|s| !s.is_empty())
                        .or(if t.cwd.is_empty() {
                            None
                        } else {
                            Some(t.cwd.as_str())
                        })
                })
                .unwrap_or(s["folder"].as_str().unwrap_or_default())
                .to_string();
            let name = s["name"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    folder
                        .trim_end_matches('/')
                        .rsplit('/')
                        .next()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("~")
                })
                .to_string();
            Space {
                id: qualify(&text(&s["id"]), machine),
                local_id: text(&s["id"]),
                name,
                folder,
                workspace_folder: s["folder"].as_str().map(String::from),
                machine: machine.into(),
                tabs,
                online,
            }
        })
        .collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_unknown_layout_fields() {
        let value = json!({"custom": {"x": 1}, "spaces": [{"id":"s", "tabs":[], "future":true}]});
        assert_eq!(layout_doc(value.clone()).unwrap(), value);
        assert!(layout_doc(json!({"spaces":[{"id":"s"}]})).is_err());
    }
    #[test]
    fn flatten_remote_children_and_cwd() {
        let doc = json!({"spaces":[{"id":"s","folder":"/repo","tabs":[{"id":"t","root":{"id":"p","content":{"terminal":"a"}}}]}]});
        let terminal = Terminal {
            address: "remote/a".into(),
            cwd: "/repo/work".into(),
            ..Default::default()
        };
        let child = Terminal {
            address: "remote/b".into(),
            parent: Some("remote/a".into()),
            state: "live".into(),
            ..Default::default()
        };
        let spaces = flatten(&doc, "remote", &[terminal, child], false);
        assert_eq!(spaces[0].folder, "/repo/work");
        assert_eq!(spaces[0].tabs[0].panes[0].children.len(), 1);
        assert_eq!(spaces[0].tabs[0].name, "1");
        assert!(!spaces[0].online);
    }
    #[test]
    fn status_priority_and_seen() {
        let mut t = Terminal {
            turn: 2,
            status: Some(TerminalStatus {
                state: Some("finished".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(status(Some(&t)), Some("done"));
        t.labels.insert("herdr.seen".into(), "2".into());
        assert_eq!(status(Some(&t)), Some("idle"));
        let blocked = Terminal {
            status: Some(TerminalStatus {
                state: Some("error".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert_eq!(rollup(&[t, blocked]), Some("blocked"));
    }
}
