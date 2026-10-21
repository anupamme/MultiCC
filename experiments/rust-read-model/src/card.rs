use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, PartialEq, Deserialize, Serialize)]
pub struct Reference {
    pub ts: i64,
}

#[derive(Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub id: String,
    pub dir_id: String,
    pub title: String,
    pub status: String,
    pub run_state: String,
    pub goal_state: String,
    pub updated_at: i64,
    pub created_at: i64,
    pub session_id: String,
    #[serde(deserialize_with = "boolean")]
    pub read_only: bool,
    pub resource: Value,
    pub attention: Value,
    pub worktree_changes: Value,
    #[serde(default)]
    pub last_message_at: i64,
    #[serde(default)]
    pub ref_count: usize,
    #[serde(default, skip_serializing)]
    refs: Vec<Reference>,
}
fn boolean<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    let value = Value::deserialize(d)?;
    Ok(value.as_bool().unwrap_or(value.as_i64().unwrap_or(0) != 0))
}
impl Card {
    pub fn project(mut self) -> Self {
        if self.last_message_at == 0 {
            self.last_message_at = [
                self.refs.iter().map(|r| r.ts).max().unwrap_or(0),
                self.created_at,
                self.updated_at,
            ]
            .into_iter()
            .find(|n| *n != 0)
            .unwrap_or(0);
        }
        if self.ref_count == 0 {
            self.ref_count = self.refs.len();
        }
        self.refs = Vec::new();
        self
    }
}
