use crate::card::Card;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};

fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
fn number(v: &Value, key: &str) -> i64 {
    v[key].as_i64().unwrap_or(0)
}
fn array(v: &Value, key: &str) -> Vec<Value> {
    v[key].as_array().cloned().unwrap_or_default()
}
fn ids(v: &Value, key: &str) -> HashSet<String> {
    array(v, key)
        .iter()
        .filter_map(|x| x.as_str().map(str::to_owned))
        .collect()
}
fn at(v: &Card) -> i64 {
    if v.last_message_at != 0 {
        v.last_message_at
    } else {
        v.updated_at
    }
}
fn state(v: &Card) -> &str {
    match v.status.as_str() {
        "archived" => "archived",
        "done" => "done",
        _ => match v.run_state.as_str() {
            "done" | "completed" => "succeeded",
            "" if v.status == "active" => "idle",
            "idle" | "queued" | "running" | "waiting" | "background" | "blocked" | "error"
            | "succeeded" | "cancelled" | "archived" => &v.run_state,
            _ => "unknown",
        },
    }
}

#[derive(Default, Clone, Serialize)]
pub struct Counts {
    total: i64,
    open: i64,
    running: i64,
    needs: i64,
    todo: i64,
    error: i64,
    archived: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    today: Option<i64>,
}
#[derive(Default)]
pub struct Model {
    rows: HashMap<String, Card>,
    order: Vec<String>,
    counts: HashMap<String, Counts>,
    metadata: Value,
    todos: HashSet<String>,
    ignored: HashSet<String>,
    memo: HashMap<String, Value>,
    memo_order: VecDeque<String>,
}
impl Model {
    fn needs(&self, t: &Card) -> bool {
        t.status.as_str() != "archived"
            && !self.ignored.contains(t.id.as_str())
            && (self.todos.contains(t.id.as_str())
                || ["waiting", "error"].contains(&state(t))
                || state(t) == "succeeded" && t.goal_state.as_str() == "interact")
    }
    fn count(&mut self, t: &Card, delta: i64) {
        let needs = self.needs(t);
        for key in ["all", t.dir_id.as_str()] {
            let c = self.counts.entry(key.into()).or_default();
            c.total += delta;
            c.open += delta * i64::from(!["done", "archived"].contains(&t.status.as_str()));
            c.running += delta * i64::from(state(t) == "running");
            c.needs += delta * i64::from(needs);
            c.todo += delta
                * i64::from(t.status.as_str() != "archived" && self.todos.contains(t.id.as_str()));
            c.error += delta * i64::from(state(t) == "error");
            c.archived += delta * i64::from(t.status.as_str() == "archived");
            if c.total == 0 {
                self.counts.remove(key);
            }
        }
    }
    pub fn apply(&mut self, tasks: Vec<Card>, command: &Value) -> Value {
        let reset = command["reset"].as_bool().unwrap_or(false);
        if reset {
            *self = Self::default();
        }
        let meta_changed = command["metadata"] != self.metadata;
        if meta_changed {
            self.metadata = command["metadata"].clone();
            self.todos = ids(&self.metadata, "taskTodos");
            self.ignored = ids(&self.metadata, "taskTodoIgnored");
        }
        let mut changed = Vec::new();
        let mut deleted = Vec::new();
        for value in array(command, "removed") {
            let id = value.as_str().unwrap_or("");
            if let Some(old) = self.rows.remove(id) {
                if !meta_changed {
                    self.count(&old, -1);
                }
                deleted.push(id.to_owned());
            }
        }
        for card in tasks {
            let id = card.id.as_str().to_owned();
            if self.rows.get(&id) == Some(&card) {
                continue;
            }
            if !meta_changed {
                if let Some(old) = self.rows.remove(&id) {
                    self.count(&old, -1);
                }
                self.count(&card, 1);
            }
            self.rows.insert(id.clone(), card);
            changed.push(id);
        }
        if meta_changed {
            self.counts.clear();
            let rows = std::mem::take(&mut self.rows);
            for card in rows.values() {
                self.count(card, 1);
            }
            self.rows = rows;
        }
        let cmp = |a: &String, b: &String| {
            at(&self.rows[b])
                .cmp(&at(&self.rows[a]))
                .then_with(|| a.cmp(b))
        };
        if reset || changed.len() + deleted.len() > self.rows.len() / 8 {
            self.order = self.rows.keys().cloned().collect();
            self.order.sort_by(cmp);
        } else {
            let dirty: HashSet<_> = changed.iter().chain(deleted.iter()).collect();
            self.order.retain(|id| !dirty.contains(id));
            for id in &changed {
                let pos = self
                    .order
                    .partition_point(|existing| cmp(existing, id).is_lt());
                self.order.insert(pos, id.clone());
            }
        }
        if reset || meta_changed || !changed.is_empty() || !deleted.is_empty() {
            self.memo.clear();
            self.memo_order.clear();
        }
        json!({"changed":changed.len(),"deleted":deleted.len(),"total":self.rows.len()})
    }
    pub fn page(&mut self, options: &Value) -> Value {
        let key = options.to_string();
        if let Some(result) = self.memo.get(&key) {
            return result.clone();
        }
        let filter = if text(options, "status").is_empty() {
            "open"
        } else {
            text(options, "status")
        };
        let needle = text(options, "query").to_lowercase();
        let dirs: HashMap<_, _> = array(&self.metadata, "directories")
            .iter()
            .map(|d| (text(d, "id").to_owned(), text(d, "name").to_owned()))
            .collect();
        let pins: HashMap<_, _> = array(&self.metadata, "taskPins")
            .iter()
            .enumerate()
            .map(|(i, v)| (v.as_str().unwrap_or("").to_owned(), i))
            .collect();
        let rank: HashMap<_, _> = array(options, "ids")
            .iter()
            .enumerate()
            .map(|(i, v)| (v.as_str().unwrap_or("").to_owned(), i))
            .collect();
        let mut list: Vec<_> = self
            .order
            .iter()
            .filter_map(|id| {
                let t = &self.rows[id];
                let dir = t.dir_id.as_str();
                if !text(options, "dirId").is_empty() && text(options, "dirId") != dir {
                    return None;
                }
                if options["ids"].is_array() && !rank.contains_key(id) {
                    return None;
                }
                if !needle.is_empty()
                    && !format!(
                        "{} {}",
                        t.title.as_str(),
                        dirs.get(dir).map(String::as_str).unwrap_or("")
                    )
                    .to_lowercase()
                    .contains(&needle)
                {
                    return None;
                }
                let selected = match filter {
                    "all" => true,
                    "recent" => t.status.as_str() != "archived",
                    "archived" => t.status.as_str() == "archived",
                    "today" => {
                        (state(t) == "succeeded" || t.status.as_str() == "done")
                            && t.updated_at >= number(options, "dayStart")
                    }
                    "needs" | "waiting" => self.needs(t),
                    "waitingReply" => state(t) == "waiting",
                    "todo" => t.status.as_str() != "archived" && self.todos.contains(id),
                    "achieved" | "interact" => {
                        state(t) == "succeeded" && t.goal_state.as_str() == filter
                    }
                    "running" | "error" | "succeeded" => state(t) == filter,
                    _ => !["done", "archived"].contains(&t.status.as_str()),
                };
                selected.then_some(t)
            })
            .collect();
        let ascending =
            text(options, "sort") == "oldest" || ["needs", "todo", "waiting"].contains(&filter);
        list.sort_by(|a, b| {
            let aid = a.id.as_str();
            let bid = b.id.as_str();
            if options["ids"].is_array() {
                return rank[aid].cmp(&rank[bid]);
            }
            if pins.contains_key(aid) || pins.contains_key(bid) {
                return pins
                    .get(aid)
                    .unwrap_or(&usize::MAX)
                    .cmp(pins.get(bid).unwrap_or(&usize::MAX));
            }
            let mut cmp = std::cmp::Ordering::Equal;
            if text(options, "sort") == "visit" {
                cmp = number(&options["visits"], aid).cmp(&number(&options["visits"], bid));
            }
            cmp = cmp.then_with(|| at(a).cmp(&at(b)));
            if !ascending {
                cmp = cmp.reverse();
            }
            cmp.then_with(|| aid.cmp(bid))
        });
        let limit = match number(options, "limit") {
            0 => 20,
            n => n.clamp(1, 50),
        } as usize;
        let pages = list.len().div_ceil(limit).max(1);
        let page = number(options, "page").clamp(1, pages as i64) as usize;
        let result = json!({"ok":true,"page":page,"pages":pages,"total":list.len(),"tasks":list.iter().skip((page-1)*limit).take(limit).collect::<Vec<_>>()});
        if self.memo.len() >= 128 {
            if let Some(old) = self.memo_order.pop_front() {
                self.memo.remove(&old);
            }
        }
        self.memo_order.push_back(key.clone());
        self.memo.insert(key, result.clone());
        result
    }
    pub fn stats(&self, day_start: i64) -> Value {
        let mut counts = self.counts.clone();
        for t in self.rows.values() {
            if (state(t) == "succeeded" || t.status.as_str() == "done") && t.updated_at >= day_start
            {
                for key in ["all", t.dir_id.as_str()] {
                    let c = counts.get_mut(key).unwrap();
                    c.today = Some(c.today.unwrap_or(0) + 1);
                }
            }
        }
        json!(counts)
    }
}
