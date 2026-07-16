use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    env,
    fs::{create_dir_all, metadata, rename, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        mpsc::{self, Receiver},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{AppHandle, Manager};

const PROTOCOL_VERSION: u8 = 1;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_LOG_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LifecycleCommandRequest {
    pub version: u8,
    pub id: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LifecycleCommandResponse {
    pub version: u8,
    pub id: Option<String>,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<LifecycleCommandError>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct LifecycleCommandError {
    pub code: String,
    pub message: String,
    pub recoverable: bool,
    #[serde(rename = "retryTarget", skip_serializing_if = "Option::is_none")]
    pub retry_target: Option<String>,
}

#[derive(Clone, Default)]
pub struct LifecycleBridge {
    process: Arc<Mutex<Option<ManagedSidecar>>>,
}

struct ManagedSidecar {
    child: Child,
    stdin: ChildStdin,
    stdout_lines: Receiver<String>,
}

#[tauri::command]
pub async fn lifecycle_request(
    app: AppHandle,
    bridge: tauri::State<'_, LifecycleBridge>,
    request: LifecycleCommandRequest,
) -> Result<LifecycleCommandResponse, ()> {
    if let Err(error) = validate_request(&request) {
        return Ok(failure(Some(request.id), error));
    }

    let request_id = request.id.clone();
    let bridge = bridge.inner().clone();
    Ok(
        match tauri::async_runtime::spawn_blocking(move || bridge.request(&app, request)).await {
            Ok(response) => response,
            Err(_) => failure(
                Some(request_id),
                bridge_error(
                    "SIDECAR_UNAVAILABLE",
                    "Teti's local lifecycle service stopped unexpectedly.",
                    true,
                    Some("lifecycle.health"),
                ),
            ),
        },
    )
}

impl LifecycleBridge {
    fn request(
        &self,
        app: &AppHandle,
        request: LifecycleCommandRequest,
    ) -> LifecycleCommandResponse {
        let id = request.id.clone();
        let mut guard = match self.process.lock() {
            Ok(guard) => guard,
            Err(_) => {
                return failure(
                    Some(id),
                    bridge_error(
                        "SIDECAR_UNAVAILABLE",
                        "Teti's local lifecycle service is unavailable.",
                        true,
                        Some("lifecycle.health"),
                    ),
                )
            }
        };

        if should_restart(guard.as_mut()) {
            *guard = None;
        }

        if guard.is_none() {
            match spawn_sidecar(app) {
                Ok(process) => *guard = Some(process),
                Err(error) => {
                    return failure(
                        Some(id),
                        bridge_error(
                            "SIDECAR_UNAVAILABLE",
                            &format!("Teti's local lifecycle service is unavailable: {error}"),
                            true,
                            Some("lifecycle.health"),
                        ),
                    )
                }
            }
        }

        let process = guard
            .as_mut()
            .expect("sidecar process should be initialized");
        let line = match serde_json::to_string(&request) {
            Ok(line) => line,
            Err(_) => {
                return failure(
                    Some(id),
                    bridge_error(
                        "MALFORMED_REQUEST",
                        "Lifecycle request could not be serialized.",
                        false,
                        None,
                    ),
                )
            }
        };

        if line.len() > MAX_LINE_BYTES {
            return failure(
                Some(id),
                bridge_error(
                    "OVERSIZED_REQUEST",
                    "Lifecycle request is too large.",
                    false,
                    None,
                ),
            );
        }

        if let Err(error) = writeln!(process.stdin, "{line}") {
            let _ = process.child.kill();
            *guard = None;
            return failure(
                Some(id),
                bridge_error(
                    "SIDECAR_UNAVAILABLE",
                    &format!("Teti's local lifecycle service is unavailable: {error}"),
                    true,
                    Some("lifecycle.health"),
                ),
            );
        }

        if let Err(error) = process.stdin.flush() {
            let _ = process.child.kill();
            *guard = None;
            return failure(
                Some(id),
                bridge_error(
                    "SIDECAR_UNAVAILABLE",
                    &format!("Teti's local lifecycle service is unavailable: {error}"),
                    true,
                    Some("lifecycle.health"),
                ),
            );
        }

        receive_matching_response(process, &id, timeout_for_method(&request.method))
    }
}

impl Drop for LifecycleBridge {
    fn drop(&mut self) {
        if Arc::strong_count(&self.process) != 1 {
            return;
        }
        if let Ok(mut guard) = self.process.lock() {
            if let Some(process) = guard.as_mut() {
                let _ = process.child.kill();
            }
        }
    }
}

fn spawn_sidecar(app: &AppHandle) -> Result<ManagedSidecar, String> {
    let sidecar_path = resolve_sidecar_path(app)?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let bundled_node = resource_dir.join("runtime").join("node");
    let bundled_rpc = resource_dir.join("runtime").join("deltachat-rpc-server");
    let node_path = env::var("TETI_NODE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            if bundled_node.exists() {
                bundled_node
            } else {
                PathBuf::from("node")
            }
        });
    let mut command = Command::new(node_path);
    command
        .arg("--experimental-strip-types")
        .arg(sidecar_path)
        .env("TETI_DESKTOP_NATIVE_PROVISIONING", "1")
        .env("TETI_PROVISIONING_MODE", "real")
        .env("TETI_CHATMAIL_RELAY_DOMAIN", "mail.seep.im")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if env::var_os("TETI_DELTACHAT_RPC_PATH").is_none() && bundled_rpc.exists() {
        command.env("TETI_DELTACHAT_RPC_PATH", bundled_rpc);
    }
    configure_node_proxy(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "sidecar stdin is unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "sidecar stdout is unavailable".to_string())?;
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                append_sanitized_log_line("sidecar", &line);
            }
        });
    }

    let (sender, receiver) = mpsc::channel();

    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            if sender.send(line).is_err() {
                break;
            }
        }
    });

    Ok(ManagedSidecar {
        child,
        stdin,
        stdout_lines: receiver,
    })
}

fn configure_node_proxy(command: &mut Command) {
    if ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]
        .iter()
        .any(|name| env::var_os(name).is_some())
    {
        command.env("NODE_USE_ENV_PROXY", "1");
        return;
    }

    #[cfg(target_os = "macos")]
    if let Some(proxy) = macos_https_proxy() {
        command
            .env("NODE_USE_ENV_PROXY", "1")
            .env("HTTPS_PROXY", &proxy)
            .env("HTTP_PROXY", proxy);
    }
}

#[cfg(target_os = "macos")]
fn macos_https_proxy() -> Option<String> {
    let output = Command::new("/usr/sbin/scutil")
        .arg("--proxy")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_macos_https_proxy(&String::from_utf8(output.stdout).ok()?)
}

#[cfg(target_os = "macos")]
fn parse_macos_https_proxy(output: &str) -> Option<String> {
    let value = |key: &str| {
        output.lines().find_map(|line| {
            let (candidate, value) = line.trim().split_once(" : ")?;
            (candidate == key).then(|| value.trim())
        })
    };

    if value("HTTPSEnable")? != "1" {
        return None;
    }
    let host = value("HTTPSProxy")?;
    if host.is_empty()
        || !host
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || ".-_".contains(character))
    {
        return None;
    }
    let port = value("HTTPSPort")?.parse::<u16>().ok()?;
    Some(format!("http://{host}:{port}"))
}

fn resolve_sidecar_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = env::var("TETI_LIFECYCLE_SIDECAR_PATH") {
        return Ok(PathBuf::from(path));
    }

    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    for file_name in ["main.mjs", "main.ts"] {
        let resource_path = resource_dir.join("lifecycle-sidecar").join(file_name);
        if resource_path.exists() {
            return Ok(resource_path);
        }
    }

    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dev_path = manifest_dir
        .parent()
        .ok_or_else(|| "desktop directory is unavailable".to_string())?
        .join("lifecycle-sidecar")
        .join("main.ts");

    if dev_path.exists() {
        return Ok(dev_path);
    }

    Err("lifecycle sidecar script was not found".to_string())
}

fn receive_matching_response(
    process: &mut ManagedSidecar,
    expected_id: &str,
    timeout: Duration,
) -> LifecycleCommandResponse {
    loop {
        match process.stdout_lines.recv_timeout(timeout) {
            Ok(line) => match parse_sidecar_response(expected_id, &line) {
                Ok(Some(response)) => return response,
                Ok(None) => continue,
                Err(error) => return failure(Some(expected_id.to_string()), error),
            },
            Err(mpsc::RecvTimeoutError::Timeout) => {
                return failure(
                    Some(expected_id.to_string()),
                    bridge_error(
                        "REQUEST_TIMEOUT",
                        "Teti took too long to respond.",
                        true,
                        Some("lifecycle.health"),
                    ),
                )
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return failure(
                    Some(expected_id.to_string()),
                    bridge_error(
                        "SIDECAR_UNAVAILABLE",
                        "Teti's local lifecycle service is unavailable.",
                        true,
                        Some("lifecycle.health"),
                    ),
                )
            }
        }
    }
}

pub fn parse_sidecar_response(
    expected_id: &str,
    line: &str,
) -> Result<Option<LifecycleCommandResponse>, LifecycleCommandError> {
    if line.len() > MAX_LINE_BYTES {
        return Err(bridge_error(
            "OVERSIZED_REQUEST",
            "Lifecycle response is too large.",
            false,
            None,
        ));
    }

    let response: LifecycleCommandResponse = serde_json::from_str(line).map_err(|_| {
        bridge_error(
            "MALFORMED_REQUEST",
            "Lifecycle sidecar returned malformed JSON.",
            true,
            Some("lifecycle.health"),
        )
    })?;

    if response.version != PROTOCOL_VERSION {
        return Err(bridge_error(
            "UNSUPPORTED_PROTOCOL_VERSION",
            "Lifecycle sidecar returned an unsupported protocol version.",
            true,
            Some("lifecycle.health"),
        ));
    }

    if response.id.as_deref() != Some(expected_id) {
        return Ok(None);
    }

    Ok(Some(response))
}

fn validate_request(request: &LifecycleCommandRequest) -> Result<(), LifecycleCommandError> {
    if request.version != PROTOCOL_VERSION {
        return Err(bridge_error(
            "UNSUPPORTED_PROTOCOL_VERSION",
            "Unsupported lifecycle protocol version.",
            false,
            None,
        ));
    }

    if request.id.trim().is_empty() || request.id.len() > 120 {
        return Err(bridge_error(
            "MALFORMED_REQUEST",
            "Lifecycle request id is invalid.",
            false,
            None,
        ));
    }

    if !is_allowed_method(&request.method) {
        return Err(bridge_error(
            "UNKNOWN_METHOD",
            "Lifecycle method is not allowed.",
            false,
            None,
        ));
    }

    Ok(())
}

fn should_restart(process: Option<&mut ManagedSidecar>) -> bool {
    match process {
        Some(process) => matches!(process.child.try_wait(), Ok(Some(_)) | Err(_)),
        None => true,
    }
}

pub fn timeout_for_method(method: &str) -> Duration {
    Duration::from_millis(match method {
        "lifecycle.health" => 2_000,
        "account.status" | "account.load" => 5_000,
        "account.create" => 120_000,
        "discovery.register" | "discovery.retry" => 15_000,
        "connection.resolve" => 15_000,
        "connection.request" | "connection.accept" | "connection.reject" => 30_000,
        "connection.poll" => 20_000,
        "connection.list" => 5_000,
        _ => 5_000,
    })
}

fn is_allowed_method(method: &str) -> bool {
    matches!(
        method,
        "lifecycle.health"
            | "account.status"
            | "account.load"
            | "account.create"
            | "discovery.register"
            | "discovery.retry"
            | "connection.resolve"
            | "connection.request"
            | "connection.list"
            | "connection.poll"
            | "connection.accept"
            | "connection.reject"
    )
}

fn failure(id: Option<String>, error: LifecycleCommandError) -> LifecycleCommandResponse {
    LifecycleCommandResponse {
        version: PROTOCOL_VERSION,
        id,
        ok: false,
        result: None,
        error: Some(error),
    }
}

fn bridge_error(
    code: &str,
    message: &str,
    recoverable: bool,
    retry_target: Option<&str>,
) -> LifecycleCommandError {
    LifecycleCommandError {
        code: code.to_string(),
        message: redact_secret_like_text(message),
        recoverable,
        retry_target: retry_target.map(ToString::to_string),
    }
}

fn append_sanitized_log_line(source: &str, line: &str) {
    if let Some(path) = log_file_path() {
        if let Some(parent) = path.parent() {
            let _ = create_dir_all(parent);
        }
        rotate_log_if_needed(&path);
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(
                file,
                "[{source}] {}",
                redact_secret_like_text(line).replace(['\n', '\r'], " ")
            );
        }
    }
}

fn log_file_path() -> Option<PathBuf> {
    env::var_os("HOME").map(|home| {
        PathBuf::from(home)
            .join("Library")
            .join("Logs")
            .join("Teti")
            .join("teti-desktop.log")
    })
}

fn rotate_log_if_needed(path: &PathBuf) {
    if matches!(metadata(path), Ok(meta) if meta.len() > MAX_LOG_BYTES) {
        let rotated = path.with_extension("log.1");
        let _ = rename(path, rotated);
    }
}

fn redact_secret_like_text(text: &str) -> String {
    let mut redacted = text.to_string();
    for marker in [
        "password=",
        "token=",
        "secret=",
        "credentials=",
        "privateKey",
    ] {
        if let Some(index) = redacted.find(marker) {
            redacted.truncate(index + marker.len());
            redacted.push_str("[redacted]");
        }
    }
    redacted.chars().take(300).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_values_are_method_specific() {
        assert_eq!(
            timeout_for_method("lifecycle.health"),
            Duration::from_millis(2_000)
        );
        assert_eq!(
            timeout_for_method("account.load"),
            Duration::from_millis(5_000)
        );
        assert_eq!(
            timeout_for_method("account.create"),
            Duration::from_millis(120_000)
        );
        assert_eq!(
            timeout_for_method("discovery.retry"),
            Duration::from_millis(15_000)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn parses_enabled_macos_https_proxy() {
        let output = r#"
<dictionary> {
  HTTPSEnable : 1
  HTTPSPort : 12334
  HTTPSProxy : 127.0.0.1
}
"#;

        assert_eq!(
            parse_macos_https_proxy(output),
            Some("http://127.0.0.1:12334".to_string())
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn rejects_disabled_or_unsafe_macos_https_proxy() {
        assert_eq!(
            parse_macos_https_proxy("HTTPSEnable : 0\nHTTPSProxy : 127.0.0.1\nHTTPSPort : 12334"),
            None
        );
        assert_eq!(
            parse_macos_https_proxy("HTTPSEnable : 1\nHTTPSProxy : bad host\nHTTPSPort : 12334"),
            None
        );
    }

    #[test]
    fn parse_response_ignores_unknown_ids() {
        let parsed = parse_sidecar_response(
            "expected",
            r#"{"version":1,"id":"other","ok":true,"result":{"status":"ok"}}"#,
        )
        .unwrap();

        assert!(parsed.is_none());
    }

    #[test]
    fn parse_response_rejects_malformed_json() {
        let error = parse_sidecar_response("expected", "{not-json").unwrap_err();

        assert_eq!(error.code, "MALFORMED_REQUEST");
        assert!(error.recoverable);
    }

    #[test]
    fn parse_response_rejects_oversized_output() {
        let error =
            parse_sidecar_response("expected", &"x".repeat(MAX_LINE_BYTES + 1)).unwrap_err();

        assert_eq!(error.code, "OVERSIZED_REQUEST");
        assert!(!error.recoverable);
    }

    #[test]
    fn request_validation_rejects_unknown_methods() {
        let error = validate_request(&LifecycleCommandRequest {
            version: 1,
            id: "r1".to_string(),
            method: "shell.exec".to_string(),
            params: None,
        })
        .unwrap_err();

        assert_eq!(error.code, "UNKNOWN_METHOD");
    }

    #[test]
    fn redaction_removes_secret_like_values() {
        let redacted = redact_secret_like_text(
            "failed password=abc token=def credentials=ghi privateKey very-secret",
        );

        assert!(!redacted.contains("abc"));
        assert!(!redacted.contains("def"));
        assert!(!redacted.contains("ghi"));
        assert!(redacted.contains("[redacted]"));
    }
}
