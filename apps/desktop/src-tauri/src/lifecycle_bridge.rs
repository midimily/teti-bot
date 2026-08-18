use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    env,
    fs::{create_dir_all, metadata, remove_file, rename, OpenOptions},
    io::{self, BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};

use crate::platform;
#[cfg(target_os = "windows")]
use crate::windows_job::WindowsJob;

#[cfg(unix)]
use std::os::unix::process::CommandExt;

const PROTOCOL_VERSION: u8 = 1;
const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_LINE_BYTES: usize = 128 * 1024;
const MAX_LOG_BYTES: u64 = 1024 * 1024;
const SIDECAR_GRACEFUL_SHUTDOWN: Duration = Duration::from_millis(3_000);
#[cfg(unix)]
const SIDECAR_TERMINATE_GRACE: Duration = Duration::from_millis(500);

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
    disabled_for_local_logout: Arc<AtomicBool>,
}

struct ManagedSidecar {
    child: Child,
    stdin: Option<ChildStdin>,
    pending: PendingResponses,
    #[cfg(target_os = "windows")]
    job: WindowsJob,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeDiagnostics {
    platform: platform::DesktopPlatform,
    architecture: platform::DesktopArchitecture,
    lifecycle_runtime: platform::LifecycleRuntime,
    profile_security: String,
    sidecar_state: &'static str,
    descendant_ownership: &'static str,
}

type PendingResponses = Arc<Mutex<HashMap<String, SyncSender<LifecycleCommandResponse>>>>;

#[tauri::command]
pub async fn lifecycle_request(
    app: AppHandle,
    bridge: tauri::State<'_, LifecycleBridge>,
    request: LifecycleCommandRequest,
) -> Result<LifecycleCommandResponse, ()> {
    if let Err(error) = validate_request(&request) {
        return Ok(failure(Some(request.id), error));
    }
    if matches!(
        platform::info().lifecycle_runtime,
        platform::LifecycleRuntime::Mock
    ) {
        return Ok(failure(
            Some(request.id),
            bridge_error(
                "LIFECYCLE_RUNTIME_UNAVAILABLE",
                "The lifecycle Runtime is not included in this desktop shell.",
                false,
                None,
            ),
        ));
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

#[tauri::command]
pub fn desktop_runtime_diagnostics(
    app: AppHandle,
    bridge: tauri::State<'_, LifecycleBridge>,
) -> DesktopRuntimeDiagnostics {
    let info = platform::info();
    let profile_security = platform::profile_security_status(&app)
        .map(|status| status.as_str().to_string())
        .unwrap_or_else(|_| "unavailable".to_string());
    let sidecar_state = bridge
        .process
        .lock()
        .ok()
        .and_then(|process| process.as_ref().map(|_| "running"))
        .unwrap_or("stopped");
    DesktopRuntimeDiagnostics {
        platform: info.platform,
        architecture: info.architecture,
        lifecycle_runtime: info.lifecycle_runtime,
        profile_security,
        sidecar_state,
        descendant_ownership: if cfg!(target_os = "windows") {
            "job-object"
        } else {
            "process-group"
        },
    }
}

impl LifecycleBridge {
    fn request(
        &self,
        app: &AppHandle,
        request: LifecycleCommandRequest,
    ) -> LifecycleCommandResponse {
        let id = request.id.clone();
        if self.disabled_for_local_logout.load(Ordering::SeqCst) {
            return failure(
                Some(id),
                bridge_error(
                    "SIDECAR_UNAVAILABLE",
                    "Teti's local lifecycle service is stopped for local profile logout.",
                    false,
                    None,
                ),
            );
        }
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

        let (sender, receiver) = mpsc::sync_channel(1);
        let pending = process.pending.clone();
        let registered = match pending.lock() {
            Ok(mut requests) if !requests.contains_key(&id) => {
                requests.insert(id.clone(), sender);
                true
            }
            _ => false,
        };
        if !registered {
            return failure(
                Some(id),
                bridge_error(
                    "MALFORMED_REQUEST",
                    "Lifecycle request id is already pending.",
                    false,
                    None,
                ),
            );
        }

        let write_result = process
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "sidecar stdin is closed"))
            .and_then(|stdin| writeln!(stdin, "{line}"));
        if let Err(error) = write_result {
            remove_pending_response(&pending, &id);
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

        let flush_result = process
            .stdin
            .as_mut()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "sidecar stdin is closed"))
            .and_then(Write::flush);
        if let Err(error) = flush_result {
            remove_pending_response(&pending, &id);
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

        let timeout = timeout_for_method(&request.method);
        drop(guard);
        wait_for_response(receiver, pending, &id, timeout)
    }
}

impl Drop for LifecycleBridge {
    fn drop(&mut self) {
        if Arc::strong_count(&self.process) == 1 {
            self.shutdown();
        }
    }
}

impl LifecycleBridge {
    pub fn shutdown(&self) {
        let process = self.process.lock().ok().and_then(|mut guard| guard.take());
        drop(process);
    }

    pub fn shutdown_for_local_logout(&self) {
        self.disabled_for_local_logout.store(true, Ordering::SeqCst);
        self.shutdown();
    }
}

impl Drop for ManagedSidecar {
    fn drop(&mut self) {
        self.terminate();
    }
}

impl ManagedSidecar {
    fn terminate(&mut self) {
        fail_pending_responses(&self.pending);
        self.stdin.take();
        if wait_for_child_exit(&mut self.child, SIDECAR_GRACEFUL_SHUTDOWN) {
            append_sanitized_log_line("bridge", "event=runtime.shutdown state=clean");
            return;
        }

        #[cfg(target_os = "windows")]
        {
            append_sanitized_log_line(
                "bridge",
                "event=runtime.shutdown state=forced ownership=job-object",
            );
            self.job.terminate();
            let _ = self.child.wait();
            return;
        }

        #[cfg(unix)]
        {
            signal_process_group(self.child.id(), 15);
            if wait_for_child_exit(&mut self.child, SIDECAR_TERMINATE_GRACE) {
                return;
            }

            signal_process_group(self.child.id(), 9);
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn wait_for_child_exit(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Err(_) => return true,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => return false,
        }
    }
}

#[cfg(unix)]
fn signal_process_group(pid: u32, signal: i32) {
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    if let Ok(pid) = i32::try_from(pid) {
        unsafe {
            let _ = kill(-pid, signal);
        }
    }
}

fn spawn_sidecar(app: &AppHandle) -> Result<ManagedSidecar, String> {
    let platform_info = platform::info();
    let platform_paths = platform::paths(app)?;
    let sidecar_path = resolve_sidecar_path(app)?;
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let bundled_node = resource_dir
        .join("runtime")
        .join(runtime_executable_name("node"));
    let bundled_rpc = resource_dir
        .join("runtime")
        .join(runtime_executable_name("deltachat-rpc-server"));
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
        .env("TETI_DESKTOP_PLATFORM", platform_info.platform.as_str())
        .env("TETI_PROFILE_DIR", platform_paths.profile_root)
        .env("TETI_DESKTOP_LOG_DIR", platform_paths.log_dir)
        .env(
            "TETI_PROFILE_SECURITY",
            platform::profile_security_status(app)?.as_str(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    command.process_group(0);
    if env::var_os("TETI_DELTACHAT_RPC_PATH").is_none() && bundled_rpc.exists() {
        command.env("TETI_DELTACHAT_RPC_PATH", bundled_rpc);
    }
    configure_node_proxy(&mut command);
    #[cfg(target_os = "windows")]
    let job = WindowsJob::new()?;
    append_sanitized_log_line(
        "bridge",
        &format!(
            "event=runtime.spawn state=starting platform={} ownership={}",
            platform_info.platform.as_str(),
            if cfg!(target_os = "windows") {
                "job-object"
            } else {
                "process-group"
            }
        ),
    );
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    if let Err(error) = job.assign(&child) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    append_sanitized_log_line(
        "bridge",
        &format!("event=runtime.spawn state=owned pid={}", child.id()),
    );

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

    let pending: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
    let response_pending = pending.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines().map_while(Result::ok) {
            dispatch_response_line(&response_pending, &line);
        }
        fail_pending_responses(&response_pending);
    });

    Ok(ManagedSidecar {
        child,
        stdin: Some(stdin),
        pending,
        #[cfg(target_os = "windows")]
        job,
    })
}

fn runtime_executable_name(base: &str) -> String {
    if cfg!(target_os = "windows") {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
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

fn wait_for_response(
    receiver: Receiver<LifecycleCommandResponse>,
    pending: PendingResponses,
    expected_id: &str,
    timeout: Duration,
) -> LifecycleCommandResponse {
    match receiver.recv_timeout(timeout) {
        Ok(response) => response,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            remove_pending_response(&pending, expected_id);
            failure(
                Some(expected_id.to_string()),
                bridge_error(
                    "REQUEST_TIMEOUT",
                    "Teti took too long to respond.",
                    true,
                    Some("lifecycle.health"),
                ),
            )
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => failure(
            Some(expected_id.to_string()),
            bridge_error(
                "SIDECAR_UNAVAILABLE",
                "Teti's local lifecycle service is unavailable.",
                true,
                Some("lifecycle.health"),
            ),
        ),
    }
}

fn dispatch_response_line(pending: &PendingResponses, line: &str) {
    let response = match parse_sidecar_response_line(line) {
        Ok(response) => response,
        Err(error) => {
            append_sanitized_log_line(
                "bridge",
                &format!("invalid sidecar response: {}", error.code),
            );
            return;
        }
    };
    let Some(id) = response.id.clone() else {
        return;
    };
    let sender = pending
        .lock()
        .ok()
        .and_then(|mut requests| requests.remove(&id));
    if let Some(sender) = sender {
        let _ = sender.send(response);
    }
}

fn remove_pending_response(pending: &PendingResponses, id: &str) {
    if let Ok(mut requests) = pending.lock() {
        requests.remove(id);
    }
}

fn fail_pending_responses(pending: &PendingResponses) {
    let requests = pending
        .lock()
        .map(|mut requests| requests.drain().collect::<Vec<_>>())
        .unwrap_or_default();
    for (id, sender) in requests {
        let _ = sender.send(failure(
            Some(id),
            bridge_error(
                "SIDECAR_UNAVAILABLE",
                "Teti's local lifecycle service is unavailable.",
                true,
                Some("lifecycle.health"),
            ),
        ));
    }
}

fn parse_sidecar_response_line(
    line: &str,
) -> Result<LifecycleCommandResponse, LifecycleCommandError> {
    if line.len() > MAX_RESPONSE_LINE_BYTES {
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

    Ok(response)
}

#[cfg(test)]
fn parse_sidecar_response(
    expected_id: &str,
    line: &str,
) -> Result<Option<LifecycleCommandResponse>, LifecycleCommandError> {
    let response = parse_sidecar_response_line(line)?;

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
        "lifecycle.health"
        | "release.status"
        | "network.environment.get"
        | "presence.get"
        | "presence.signal.set" => 2_000,
        "network.environment.set" => 5_000,
        "passport.get" => 2_000,
        "passport.sharing.set" => 5_000,
        "agent.observation.get" => 2_000,
        "agent.observation.scan" | "agent.observation.override.set" => 10_000,
        "osaurus.native.get" => 2_000,
        "osaurus.native.set" => 5_000,
        "account.status" | "account.load" => 5_000,
        "account.create" => 120_000,
        "network.identity.retry" => 30_000,
        "connection.resolve" => 15_000,
        "connection.request" | "connection.accept" | "connection.reject" => 30_000,
        "task.send" => 30_000,
        "task.list"
        | "task.summary"
        | "task.get"
        | "task.attachment.resolve"
        | "task.delegation.targets"
        | "task.execution.get" => 2_000,
        "task.attachment.stage"
        | "task.approve"
        | "task.delegation.approve"
        | "task.reject"
        | "task.cancel"
        | "task.execution.resume"
        | "task.input.submit"
        | "task.pause"
        | "task.continue"
        | "task.complete"
        | "task.renew" => 10_000,
        "memory.get" => 2_000,
        "memory.export" => 10_000,
        "memory.authorization.set" | "memory.task.save" | "memory.delete" => 5_000,
        _ => 5_000,
    })
}

fn is_allowed_method(method: &str) -> bool {
    matches!(
        method,
        "lifecycle.health"
            | "release.status"
            | "network.contract.get"
            | "network.environment.get"
            | "network.environment.set"
            | "presence.get"
            | "presence.signal.set"
            | "account.status"
            | "account.load"
            | "account.create"
            | "network.identity.retry"
            | "connection.resolve"
            | "connection.request"
            | "connection.accept"
            | "connection.reject"
            | "task.send"
            | "task.list"
            | "task.summary"
            | "task.get"
            | "task.attachment.stage"
            | "task.attachment.resolve"
            | "task.approve"
            | "task.delegation.targets"
            | "task.delegation.approve"
            | "task.reject"
            | "task.cancel"
            | "task.execution.get"
            | "task.execution.resume"
            | "task.input.submit"
            | "task.pause"
            | "task.continue"
            | "task.complete"
            | "task.renew"
            | "memory.get"
            | "memory.authorization.set"
            | "memory.task.save"
            | "memory.delete"
            | "memory.export"
            | "passport.get"
            | "passport.sharing.set"
            | "agent.observation.get"
            | "agent.observation.scan"
            | "agent.observation.override.set"
            | "osaurus.native.get"
            | "osaurus.native.set"
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

pub(crate) fn append_sanitized_log_line(source: &str, line: &str) {
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
    if let Some(log_dir) = env::var_os("TETI_DESKTOP_LOG_DIR") {
        return Some(PathBuf::from(log_dir).join("teti-desktop.log"));
    }
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
        let _ = remove_file(&rotated);
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
    fn local_logout_permanently_disables_sidecar_respawn_for_this_app_process() {
        let bridge = LifecycleBridge::default();
        assert!(!bridge.disabled_for_local_logout.load(Ordering::SeqCst));
        bridge.shutdown_for_local_logout();
        assert!(bridge.disabled_for_local_logout.load(Ordering::SeqCst));
    }

    #[test]
    fn timeout_values_are_method_specific() {
        for method in [
            "release.status",
            "network.identity.retry",
            "passport.get",
            "agent.observation.get",
            "task.send",
            "task.list",
            "task.approve",
            "task.attachment.stage",
            "task.delegation.targets",
            "task.delegation.approve",
            "task.execution.get",
            "task.execution.resume",
            "task.input.submit",
            "task.pause",
            "task.continue",
            "task.complete",
            "task.renew",
            "memory.get",
            "memory.authorization.set",
            "memory.task.save",
            "memory.delete",
            "memory.export",
            "osaurus.native.get",
            "osaurus.native.set",
        ] {
            assert!(is_allowed_method(method), "{method} must reach the sidecar");
        }
        assert!(!is_allowed_method("usage.get"));
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
            timeout_for_method("network.identity.retry"),
            Duration::from_millis(30_000)
        );
        assert_eq!(
            timeout_for_method("passport.get"),
            Duration::from_millis(2_000)
        );
        assert_eq!(
            timeout_for_method("passport.sharing.set"),
            Duration::from_millis(5_000)
        );
        assert_eq!(
            timeout_for_method("agent.observation.scan"),
            Duration::from_millis(10_000)
        );
        assert_eq!(
            timeout_for_method("task.send"),
            Duration::from_millis(30_000)
        );
        assert_eq!(
            timeout_for_method("task.list"),
            Duration::from_millis(2_000)
        );
        assert_eq!(
            timeout_for_method("task.approve"),
            Duration::from_millis(10_000)
        );
        assert_eq!(
            timeout_for_method("task.delegation.targets"),
            Duration::from_millis(2_000)
        );
        assert_eq!(
            timeout_for_method("task.execution.resume"),
            Duration::from_millis(10_000)
        );
        assert_eq!(
            timeout_for_method("memory.get"),
            Duration::from_millis(2_000)
        );
        assert_eq!(
            timeout_for_method("memory.export"),
            Duration::from_millis(10_000)
        );
        assert_eq!(
            timeout_for_method("osaurus.native.get"),
            Duration::from_millis(2_000)
        );
        assert_eq!(
            timeout_for_method("osaurus.native.set"),
            Duration::from_millis(5_000)
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
        let error = parse_sidecar_response("expected", &"x".repeat(MAX_RESPONSE_LINE_BYTES + 1))
            .unwrap_err();

        assert_eq!(error.code, "OVERSIZED_REQUEST");
        assert!(!error.recoverable);
    }

    #[test]
    fn response_dispatcher_routes_out_of_order_requests_by_id() {
        let pending: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let (first_sender, first_receiver) = mpsc::sync_channel(1);
        let (second_sender, second_receiver) = mpsc::sync_channel(1);
        pending
            .lock()
            .unwrap()
            .insert("first".to_string(), first_sender);
        pending
            .lock()
            .unwrap()
            .insert("second".to_string(), second_sender);

        dispatch_response_line(
            &pending,
            r#"{"version":1,"id":"second","ok":true,"result":{"value":2}}"#,
        );
        dispatch_response_line(
            &pending,
            r#"{"version":1,"id":"first","ok":true,"result":{"value":1}}"#,
        );

        assert_eq!(
            second_receiver.recv().unwrap().id.as_deref(),
            Some("second")
        );
        assert_eq!(first_receiver.recv().unwrap().id.as_deref(), Some("first"));
        assert!(pending.lock().unwrap().is_empty());
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

    #[cfg(unix)]
    #[test]
    fn managed_sidecar_drop_closes_stdin_waits_and_reaps_the_child() {
        let mut command = Command::new("/bin/cat");
        command
            .process_group(0)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = command.spawn().expect("test child should start");
        let pid = child.id();
        let stdin = child.stdin.take().expect("test child stdin should exist");
        let pending: PendingResponses = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = mpsc::sync_channel(1);
        pending
            .lock()
            .unwrap()
            .insert("pending".to_string(), sender);

        drop(ManagedSidecar {
            child,
            stdin: Some(stdin),
            pending,
        });

        assert!(receiver.recv_timeout(Duration::from_secs(1)).is_ok());
        let alive = Command::new("/bin/kill")
            .arg("-0")
            .arg(pid.to_string())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        assert!(!alive, "managed sidecar child must be reaped");
    }
}
