use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NativeCommandError {
    code: &'static str,
}

impl NativeCommandError {
    pub const fn new(code: &'static str) -> Self {
        Self { code }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn errors_expose_only_a_stable_code() {
        let value =
            serde_json::to_value(NativeCommandError::new("TASK_RESULT_IMAGE_OPEN_FAILED")).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "code": "TASK_RESULT_IMAGE_OPEN_FAILED" })
        );
    }
}
