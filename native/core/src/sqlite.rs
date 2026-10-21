//! SQLite 所有权、参数绑定、执行及事务均由 Rust 管理；不依赖 Node。
pub use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags};
use std::{collections::HashMap, time::Duration};

#[derive(Debug)]
pub struct Error {
    pub code: i32,
    pub message: String,
}
impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Self {
            code: match &error {
                rusqlite::Error::SqliteFailure(e, _) => e.extended_code,
                rusqlite::Error::InvalidParameterCount(..)
                | rusqlite::Error::InvalidParameterName(..) => 25,
                _ => 1,
            },
            message: error.to_string(),
        }
    }
}
pub type Result<T> = std::result::Result<T, Error>;
fn invalid(message: &str) -> Error {
    Error {
        code: 21,
        message: message.into(),
    }
}

pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub changes: u64,
    pub last_insert_rowid: i64,
}

pub struct Database {
    connection: Option<Connection>,
    frames: Vec<(u32, Option<String>)>,
    sequence: u32,
}

impl Database {
    pub fn open(file: &str, readonly: bool, must_exist: bool, timeout: u32) -> Result<Self> {
        let mut flags = if readonly {
            OpenFlags::SQLITE_OPEN_READ_ONLY
        } else {
            OpenFlags::SQLITE_OPEN_READ_WRITE
        };
        if !readonly && !must_exist {
            flags |= OpenFlags::SQLITE_OPEN_CREATE;
        }
        let connection = Connection::open_with_flags(file, flags)?;
        connection.busy_timeout(Duration::from_millis(timeout.into()))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        connection.set_prepared_statement_cache_capacity(256);
        Ok(Self {
            connection: Some(connection),
            frames: Vec::new(),
            sequence: 0,
        })
    }

    fn connection(&self) -> Result<&Connection> {
        self.connection
            .as_ref()
            .ok_or_else(|| invalid("database connection is not open"))
    }
    pub fn close(&mut self) -> Result<()> {
        if let Some(connection) = self.connection.take() {
            if let Err((connection, error)) = connection.close() {
                self.connection = Some(connection);
                return Err(error.into());
            }
        }
        self.frames.clear();
        Ok(())
    }
    pub fn in_transaction(&self) -> Result<bool> {
        Ok(!self.connection()?.is_autocommit())
    }
    pub fn exec(&self, sql: &str) -> Result<()> {
        self.connection()?.execute_batch(sql)?;
        Ok(())
    }
    pub fn columns(&self, sql: &str) -> Result<Vec<(String, Option<String>)>> {
        let statement = self.connection()?.prepare_cached(sql)?;
        Ok(statement
            .columns()
            .into_iter()
            .map(|c| (c.name().into(), c.decl_type().map(String::from)))
            .collect())
    }

    pub fn query(
        &self,
        sql: &str,
        positional: Vec<Value>,
        named: HashMap<String, Value>,
        mode: u32,
    ) -> Result<QueryResult> {
        let connection = self.connection()?;
        let mut statement = connection.prepare_cached(sql)?;
        statement.clear_bindings();
        let mut position = 0;
        // 缓存语句每次清空绑定，缺省值为 NULL；忽略多余对象字段。
        for i in 1..=statement.parameter_count() {
            let value = if let Some(name) = statement.parameter_name(i) {
                let bare = &name[1..];
                if !named.contains_key(name)
                    && named.contains_key(bare)
                    && (1..=statement.parameter_count()).any(|j| {
                        statement
                            .parameter_name(j)
                            .is_some_and(|other| other != name && &other[1..] == bare)
                    })
                {
                    return Err(invalid("ambiguous named parameter; use its full prefix"));
                }
                named
                    .get(name)
                    .or_else(|| named.get(bare))
                    .unwrap_or(&Value::Null)
            } else {
                let value = positional.get(position).unwrap_or(&Value::Null);
                position += 1;
                value
            };
            statement.raw_bind_parameter(i, value)?;
        }
        if positional.len() > position {
            return Err(Error {
                code: 25,
                message: "column index out of range: too many parameter values".into(),
            });
        }
        let columns: Vec<String> = statement
            .column_names()
            .into_iter()
            .map(String::from)
            .collect();
        let mut output = Vec::new();
        {
            let mut rows = statement.raw_query();
            while let Some(row) = rows.next()? {
                if mode != 0 {
                    output.push(
                        (0..columns.len())
                            .map(|i| row.get(i))
                            .collect::<rusqlite::Result<Vec<Value>>>()?,
                    );
                }
                if mode == 1 {
                    break;
                }
            }
        }
        Ok(QueryResult {
            columns,
            rows: output,
            changes: connection.changes(),
            last_insert_rowid: connection.last_insert_rowid(),
        })
    }

    pub fn begin(&mut self, mode: &str) -> Result<u32> {
        if !["", "DEFERRED", "IMMEDIATE", "EXCLUSIVE"].contains(&mode) {
            return Err(invalid("invalid transaction mode"));
        }
        self.sequence = self
            .sequence
            .checked_add(1)
            .ok_or_else(|| invalid("transaction sequence exhausted"))?;
        let id = self.sequence;
        let name = if self.in_transaction()? {
            Some(format!("multicc_sp_{id}"))
        } else {
            None
        };
        if let Some(name) = &name {
            self.exec(&format!("SAVEPOINT {name}"))?;
        } else {
            self.exec(&format!("BEGIN {mode}"))?;
        }
        self.frames.push((id, name));
        Ok(id)
    }

    pub fn finish(&mut self, id: u32, commit: bool) -> Result<()> {
        let Some((last, name)) = self.frames.last() else {
            return Err(invalid("no active transaction frame"));
        };
        if *last != id {
            return Err(invalid("transactions must finish in reverse order"));
        }
        let name = name.clone();
        self.frames.pop();
        let rollback = |this: &Self| -> Result<()> {
            if !this.in_transaction()? {
                return Ok(());
            }
            if let Some(name) = &name {
                this.exec(&format!("ROLLBACK TO {name}; RELEASE {name}"))
            } else {
                this.exec("ROLLBACK")
            }
        };
        if !commit {
            return rollback(self);
        }
        let result = if let Some(name) = &name {
            self.exec(&format!("RELEASE {name}"))
        } else {
            self.exec("COMMIT")
        };
        if result.is_err() {
            let _ = rollback(self);
        }
        result
    }
}

pub fn version() -> &'static str {
    rusqlite::version()
}
