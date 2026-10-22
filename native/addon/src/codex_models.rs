use napi::{bindgen_prelude::AsyncTask, Env, Result, Task};
use napi_derive::napi;
pub struct Refresh {
    input: String,
}
impl Task for Refresh {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        multicc_core::codex_models::refresh(&self.input).map_err(napi::Error::from_reason)
    }
    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}
#[napi]
pub fn codex_models_refresh(input: String) -> AsyncTask<Refresh> {
    AsyncTask::new(Refresh { input })
}
#[napi]
pub fn codex_models_peek(home: String) -> String {
    multicc_core::codex_models::peek(&home)
}

pub struct Load {
    home: String,
}
impl Task for Load {
    type Output = String;
    type JsValue = String;
    fn compute(&mut self) -> Result<String> {
        multicc_core::codex_models::load(&self.home).map_err(napi::Error::from_reason)
    }
    fn resolve(&mut self, _: Env, output: String) -> Result<String> {
        Ok(output)
    }
}
#[napi]
pub fn codex_models_load(home: String) -> AsyncTask<Load> {
    AsyncTask::new(Load { home })
}
