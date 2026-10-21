use multicc_core::sqlite::{self, Value};
use napi::bindgen_prelude::{BigInt, Either5, Null, Uint8Array};
use napi::{Error, Result};
use napi_derive::napi;
use std::collections::HashMap;

// Most stored values are JSON/text. Test String first to avoid constructing
// failed N-API conversion errors for every ordinary text parameter.
type JsValue = Either5<String, f64, Null, BigInt, Uint8Array>;
const MAX_SAFE: i64 = 9_007_199_254_740_991;
fn error(e: sqlite::Error) -> Error {
    Error::from_reason(format!("MULTICC_SQLITE:{}:{}", e.code, e.message))
}
fn input(v: JsValue) -> Result<Value> {
    Ok(match v {
        Either5::A(s) => Value::Text(s),
        Either5::B(n) => Value::Real(n),
        Either5::C(_) => Value::Null,
        Either5::D(b) => {
            let (n, lossless) = b.get_i64();
            if !lossless {
                return Err(Error::from_reason(
                    "SQLite integer exceeds signed 64-bit range",
                ));
            }
            Value::Integer(n)
        }
        Either5::E(bytes) => Value::Blob(bytes.to_vec()),
    })
}
fn integer(n: i64) -> Result<f64> {
    if !(-MAX_SAFE..=MAX_SAFE).contains(&n) {
        return Err(Error::from_reason(
            "SQLite integer outside JavaScript safe integer range",
        ));
    }
    Ok(n as f64)
}
fn output(v: Value) -> Result<JsValue> {
    Ok(match v {
        Value::Null => Either5::C(Null),
        Value::Integer(n) => Either5::B(integer(n)?),
        Value::Real(n) => Either5::B(n),
        Value::Text(s) => Either5::A(s),
        Value::Blob(bytes) => Either5::E(Uint8Array::new(bytes)),
    })
}
#[napi(object)]
pub struct SqliteRows {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<JsValue>>,
    pub changes: f64,
    pub last_insert_rowid: f64,
}
#[napi(object)]
pub struct SqliteColumn {
    pub name: String,
    pub r#type: Option<String>,
}
#[napi]
pub struct RustDatabase {
    inner: sqlite::Database,
}
#[napi]
impl RustDatabase {
    #[napi(constructor)]
    pub fn new(file: String, readonly: bool, must_exist: bool, timeout: u32) -> Result<Self> {
        Ok(Self {
            inner: sqlite::Database::open(&file, readonly, must_exist, timeout).map_err(error)?,
        })
    }
    #[napi]
    pub fn exec(&self, sql: String) -> Result<()> {
        self.inner.exec(&sql).map_err(error)
    }
    #[napi]
    pub fn columns(&self, sql: String) -> Result<Vec<SqliteColumn>> {
        Ok(self
            .inner
            .columns(&sql)
            .map_err(error)?
            .into_iter()
            .map(|(name, r#type)| SqliteColumn { name, r#type })
            .collect())
    }
    #[napi]
    pub fn query(
        &self,
        sql: String,
        positional: Vec<JsValue>,
        named: HashMap<String, JsValue>,
        mode: u32,
    ) -> Result<SqliteRows> {
        let positional = positional.into_iter().map(input).collect::<Result<_>>()?;
        let named = named
            .into_iter()
            .map(|(k, v)| Ok((k, input(v)?)))
            .collect::<Result<_>>()?;
        let result = self
            .inner
            .query(&sql, positional, named, mode)
            .map_err(error)?;
        Ok(SqliteRows {
            columns: result.columns,
            rows: result
                .rows
                .into_iter()
                .map(|row| row.into_iter().map(output).collect())
                .collect::<Result<_>>()?,
            changes: result.changes as f64,
            last_insert_rowid: if mode == 0 {
                integer(result.last_insert_rowid)?
            } else {
                0.0
            },
        })
    }
    #[napi]
    pub fn begin(&mut self, mode: String) -> Result<u32> {
        self.inner.begin(&mode).map_err(error)
    }
    #[napi]
    pub fn finish(&mut self, id: u32, commit: bool) -> Result<()> {
        self.inner.finish(id, commit).map_err(error)
    }
    #[napi(getter)]
    pub fn is_transaction(&self) -> Result<bool> {
        self.inner.in_transaction().map_err(error)
    }
    #[napi]
    pub fn close(&mut self) -> Result<()> {
        self.inner.close().map_err(error)
    }
}
#[napi]
pub fn sqlite_version() -> String {
    sqlite::version().into()
}
