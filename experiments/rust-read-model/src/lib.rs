mod card;
mod model;
use card::Card;
use model::Model;
use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, value::RawValue, Value};
use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

#[derive(Default)]
struct State {
    model: Model,
    db: Option<Connection>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Command<'a> {
    op: String,
    #[serde(default, borrow)]
    tasks: Vec<&'a RawValue>,
    #[serde(default)]
    reset: bool,
    #[serde(default)]
    removed: Vec<String>,
    #[serde(default)]
    metadata: Value,
    #[serde(default)]
    options: Value,
    #[serde(default)]
    day_start: i64,
    #[serde(default)]
    file: String,
    #[serde(default)]
    sql: String,
}
impl State {
    fn run(&mut self, cmd: Command<'_>) -> std::result::Result<Value, String> {
        match cmd.op.as_str() {
            "gc" => Ok(json!({})),
            "apply" => {
                let cards = cmd
                    .tasks
                    .iter()
                    .map(|raw| serde_json::from_str::<Card>(raw.get()).map(Card::project))
                    .collect::<std::result::Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                Ok(self.model.apply(
                    cards,
                    &json!({"reset":cmd.reset,"metadata":cmd.metadata,"removed":cmd.removed}),
                ))
            }
            "page" => Ok(self.model.page(&cmd.options)),
            "stats" => Ok(self.model.stats(cmd.day_start)),
            "dbOpen" => {
                let db = Connection::open(&cmd.file).map_err(|e| e.to_string())?;
                db.execute_batch(
                    "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;",
                )
                .map_err(|e| e.to_string())?;
                self.db = Some(db);
                Ok(json!({"sqlite":rusqlite::version()}))
            }
            "dbLoad" => {
                let db = self.db.as_ref().ok_or("未打开数据库")?;
                let mut stmt = db.prepare_cached(&cmd.sql).map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                let mut cards = Vec::new();
                for row in rows {
                    let source: Card = serde_json::from_str(&row.map_err(|e| e.to_string())?)
                        .map_err(|e| e.to_string())?;
                    cards.push(source.project());
                }
                Ok(self
                    .model
                    .apply(cards, &json!({"reset":true,"metadata":cmd.metadata})))
            }
            "dbWrite" => {
                let tasks = &cmd.tasks;
                let db = self.db.as_mut().ok_or("未打开数据库")?;
                let tx = db.transaction().map_err(|e| e.to_string())?;
                {
                    let mut stmt=tx.prepare_cached("INSERT INTO shell_records(kind,id,body) VALUES ('task',?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body").map_err(|e|e.to_string())?;
                    for t in tasks {
                        #[derive(Deserialize)]
                        struct Identity {
                            id: String,
                        }
                        let identity: Identity =
                            serde_json::from_str(t.get()).map_err(|e| e.to_string())?;
                        stmt.execute(params![identity.id, t.get()])
                            .map_err(|e| e.to_string())?;
                    }
                }
                tx.commit().map_err(|e| e.to_string())?;
                Ok(json!({"written":tasks.len()}))
            }
            "close" => {
                self.db = None;
                self.model = Model::default();
                Ok(json!({"closed":true}))
            }
            _ => Err("未知实验命令".into()),
        }
    }
}
#[napi(object)]
pub struct Reply {
    pub result: String,
    pub compute_ms: f64,
}
#[napi]
pub struct Experiment {
    state: Arc<Mutex<State>>,
}
pub struct Job {
    state: Arc<Mutex<State>>,
    input: String,
}
impl Task for Job {
    type Output = Reply;
    type JsValue = Reply;
    fn compute(&mut self) -> Result<Reply> {
        let start = Instant::now();
        let cmd = serde_json::from_str(&self.input)
            .map_err(|e| napi::Error::from_reason(e.to_string()))?;
        let value = self
            .state
            .lock()
            .map_err(|_| napi::Error::from_reason("实验锁中毒"))?
            .run(cmd)
            .map_err(napi::Error::from_reason)?;
        Ok(Reply {
            result: value.to_string(),
            compute_ms: start.elapsed().as_secs_f64() * 1000.0,
        })
    }
    fn resolve(&mut self, _: Env, reply: Reply) -> Result<Reply> {
        Ok(reply)
    }
}
#[napi]
impl Experiment {
    #[napi(constructor)]
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State::default())),
        }
    }
    #[napi]
    pub fn run(&self, input: String) -> AsyncTask<Job> {
        AsyncTask::new(Job {
            state: self.state.clone(),
            input,
        })
    }
}
impl Default for Experiment {
    fn default() -> Self {
        Self::new()
    }
}
