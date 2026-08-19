mod lifecycle_bridge;
#[cfg(target_os = "macos")]
mod macos_panel;
mod native_error;
mod platform;
mod window;
#[cfg(target_os = "windows")]
mod windows_job;
#[cfg(target_os = "windows")]
mod windows_native;
#[cfg(target_os = "windows")]
mod windows_tray;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::native_error::NativeCommandError;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalProfileLogoutResult {
    cleared: bool,
    server_data_deleted: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PanelDiagnosticEntry {
    occurred_at: String,
    level: String,
    event: String,
    #[serde(default)]
    fields: BTreeMap<String, serde_json::Value>,
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        if let Some(window) = app.get_webview_window("island") {
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            lifecycle_bridge::append_sanitized_log_line(
                "desktop",
                "event=window.recreate state=requested reason=second-instance",
            );
            let app = app.clone();
            std::thread::spawn(move || match window::create_island_window(&app) {
                Ok(window) => {
                    let _ = window.set_focus();
                    lifecycle_bridge::append_sanitized_log_line(
                        "desktop",
                        "event=window.recreate state=completed reason=second-instance",
                    );
                }
                Err(_) => lifecycle_bridge::append_sanitized_log_line(
                    "desktop",
                    "event=window.recreate state=failed reason=second-instance",
                ),
            });
        }
        let _ = app.emit("teti://dock-activate", ());
    }));
    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .manage(lifecycle_bridge::LifecycleBridge::default())
        .on_window_event(|window, event| {
            #[cfg(target_os = "windows")]
            if window.label() == "island" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        lifecycle_bridge::append_sanitized_log_line(
                            "desktop",
                            "event=window.close state=prevented platform=windows",
                        );
                        let _ = window.show();
                    }
                    tauri::WindowEvent::Destroyed => {
                        lifecycle_bridge::append_sanitized_log_line(
                            "desktop",
                            "event=window.destroyed platform=windows",
                        );
                    }
                    _ => {}
                }
            }
        });
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    let app = builder
        .setup(|app| {
            platform::configure_process_environment(app.handle()).map_err(std::io::Error::other)?;
            window::create_island_window(app.handle())?;
            #[cfg(target_os = "windows")]
            windows_tray::install(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lifecycle_bridge::lifecycle_request,
            lifecycle_bridge::desktop_runtime_diagnostics,
            platform::desktop_platform_info,
            read_app_locale_preference,
            write_app_locale_preference,
            write_panel_diagnostic,
            logout_local_profile,
            restart_application,
            window::set_island_mode,
            window::set_connection_detail_height,
            window::position_island,
            window::show_island,
            window::hide_island,
            window::current_monitor_info,
            pick_task_images,
            open_task_result_image,
            reveal_task_result_image,
            save_task_result_image
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Teti Desktop");

    app.run(|handle, event| {
        if matches!(
            &event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            handle
                .state::<lifecycle_bridge::LifecycleBridge>()
                .shutdown();
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            let _ = handle.emit("teti://dock-activate", ());
        }
    });
}

#[tauri::command]
fn read_app_locale_preference(app: tauri::AppHandle) -> Result<Option<String>, NativeCommandError> {
    platform::read_locale_preference(&app)
        .map_err(|_| NativeCommandError::new("LOCALE_PREFERENCE_READ_FAILED"))
}

#[tauri::command]
fn write_app_locale_preference(
    app: tauri::AppHandle,
    preference: String,
) -> Result<(), NativeCommandError> {
    if !matches!(preference.as_str(), "auto" | "zh-Hans" | "en") {
        return Err(NativeCommandError::new("LOCALE_PREFERENCE_INVALID"));
    }
    platform::write_locale_preference(&app, &preference)
        .map_err(|_| NativeCommandError::new("LOCALE_PREFERENCE_WRITE_FAILED"))
}

#[tauri::command]
fn write_panel_diagnostic(entry: PanelDiagnosticEntry) -> Result<(), String> {
    if !matches!(entry.level.as_str(), "debug" | "info" | "warn" | "error") {
        return Err("Invalid panel diagnostic level.".to_string());
    }
    if !should_persist_panel_diagnostic(&entry.level) {
        return Ok(());
    }
    let line = format_panel_diagnostic(&entry)?;
    lifecycle_bridge::append_sanitized_log_line("desktop", &line);
    Ok(())
}

fn should_persist_panel_diagnostic(level: &str) -> bool {
    let release = option_env!("TETI_BUILD_TYPE") == Some("release");
    should_persist_panel_diagnostic_for(release, level)
}

fn should_persist_panel_diagnostic_for(release: bool, level: &str) -> bool {
    !release || matches!(level, "warn" | "error")
}

fn format_panel_diagnostic(entry: &PanelDiagnosticEntry) -> Result<String, String> {
    validate_diagnostic_token(&entry.event, 64, "event")?;
    if entry.occurred_at.len() > 40
        || entry.occurred_at.is_empty()
        || !entry.occurred_at.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | ':' | '.' | '+' | 'T' | 'Z')
        })
    {
        return Err("Invalid panel diagnostic timestamp.".to_string());
    }
    if entry.fields.len() > 12 {
        return Err("Panel diagnostic has too many fields.".to_string());
    }
    let mut fields = Vec::with_capacity(entry.fields.len());
    for (key, value) in &entry.fields {
        validate_diagnostic_token(key, 32, "field")?;
        let rendered = match value {
            serde_json::Value::Bool(value) => value.to_string(),
            serde_json::Value::Number(value) => value.to_string(),
            serde_json::Value::String(value) => {
                validate_diagnostic_token(value, 80, "value")?;
                format!("\"{value}\"")
            }
            _ => return Err("Invalid panel diagnostic field value.".to_string()),
        };
        fields.push(format!("{key}={rendered}"));
    }
    Ok(format!(
        "{} level={} event={}{}",
        entry.occurred_at,
        entry.level,
        entry.event,
        if fields.is_empty() {
            String::new()
        } else {
            format!(" {}", fields.join(" "))
        }
    ))
}

fn validate_diagnostic_token(value: &str, maximum: usize, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > maximum
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.' | ':')
        })
    {
        return Err(format!("Invalid panel diagnostic {label}."));
    }
    Ok(())
}

#[tauri::command]
async fn logout_local_profile(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, lifecycle_bridge::LifecycleBridge>,
) -> Result<LocalProfileLogoutResult, NativeCommandError> {
    lifecycle_bridge::append_sanitized_log_line(
        "desktop",
        "event=local-profile.logout state=requested",
    );
    let profile = platform::paths(&app)
        .map(|paths| paths.profile_root)
        .map_err(|_| NativeCommandError::new("LOCAL_PROFILE_RESOLVE_FAILED"))?;
    platform::validate_profile_reset_target(&app, &profile)
        .map_err(|_| NativeCommandError::new("LOCAL_PROFILE_TARGET_INVALID"))?;
    let bridge = bridge.inner().clone();
    let clear_result = tauri::async_runtime::spawn_blocking(move || {
        bridge.shutdown_for_local_logout();
        remove_local_teti_profile(&profile)
    })
    .await
    .map_err(|_| NativeCommandError::new("LOCAL_RUNTIME_SHUTDOWN_FAILED"));
    let cleared = match clear_result {
        Ok(Ok(cleared)) => cleared,
        Ok(Err(_)) => {
            lifecycle_bridge::append_sanitized_log_line(
                "desktop",
                "event=local-profile.logout state=failed stage=profile-clear",
            );
            return Err(NativeCommandError::new("LOCAL_PROFILE_CLEAR_FAILED"));
        }
        Err(error) => {
            lifecycle_bridge::append_sanitized_log_line(
                "desktop",
                "event=local-profile.logout state=failed stage=runtime-shutdown",
            );
            return Err(error);
        }
    };
    lifecycle_bridge::append_sanitized_log_line(
        "desktop",
        if cleared {
            "event=local-profile.logout state=cleared"
        } else {
            "event=local-profile.logout state=already-empty"
        },
    );

    Ok(LocalProfileLogoutResult {
        cleared,
        server_data_deleted: false,
    })
}

#[tauri::command]
fn restart_application(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, lifecycle_bridge::LifecycleBridge>,
) -> Result<(), NativeCommandError> {
    lifecycle_bridge::append_sanitized_log_line(
        "desktop",
        "event=native-shell.restart state=requested",
    );
    bridge.shutdown();
    app.restart()
}

fn remove_local_teti_profile(profile: &std::path::Path) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(profile) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not inspect the local Teti profile: {error}")),
    };
    if profile_entry_is_linked(&metadata) {
        return Err("Refusing to clear a symbolic local Teti profile root.".to_string());
    }

    remove_profile_entry(profile, metadata.is_dir())
        .map(|_| true)
        .map_err(|error| format!("Could not clear the local Teti profile: {error}"))
}

fn profile_entry_is_linked(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(target_os = "windows"))]
    false
}

fn remove_profile_entry(profile: &std::path::Path, is_dir: bool) -> std::io::Result<()> {
    #[cfg(target_os = "windows")]
    const MAX_ATTEMPTS: usize = 8;
    #[cfg(not(target_os = "windows"))]
    const MAX_ATTEMPTS: usize = 1;

    for attempt in 0..MAX_ATTEMPTS {
        let result = if is_dir {
            std::fs::remove_dir_all(profile)
        } else {
            std::fs::remove_file(profile)
        };
        match result {
            Ok(()) => return Ok(()),
            Err(error)
                if attempt + 1 < MAX_ATTEMPTS && profile_reset_error_is_retryable(&error) =>
            {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => return Err(error),
        }
    }
    unreachable!("profile reset attempts always return")
}

fn profile_reset_error_is_retryable(error: &std::io::Error) -> bool {
    #[cfg(target_os = "windows")]
    {
        return matches!(error.raw_os_error(), Some(5 | 32 | 33));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = error;
        false
    }
}

#[tauri::command]
async fn pick_task_images(
    window: tauri::WebviewWindow,
    title: String,
    filter_name: String,
) -> Result<Vec<String>, NativeCommandError> {
    let title = validated_dialog_label(title)?;
    let filter_name = validated_dialog_label(filter_name)?;
    let files = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(&title)
        .add_filter(&filter_name, &["png", "jpg", "jpeg"])
        .pick_files()
        .await;
    Ok(files
        .unwrap_or_default()
        .into_iter()
        .take(4)
        .map(|file| file.path().to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
async fn open_task_result_image(
    app: tauri::AppHandle,
    path: String,
) -> Result<(), NativeCommandError> {
    let source = validated_task_result_image(&app, &path)?;
    app.opener()
        .open_path(source.to_string_lossy().into_owned(), None::<String>)
        .map_err(|_| NativeCommandError::new("TASK_RESULT_IMAGE_OPEN_FAILED"))
}

#[tauri::command]
async fn reveal_task_result_image(
    app: tauri::AppHandle,
    path: String,
) -> Result<(), NativeCommandError> {
    let source = validated_task_result_image(&app, &path)?;
    app.opener()
        .reveal_item_in_dir(&source)
        .map_err(|_| NativeCommandError::new("TASK_RESULT_IMAGE_REVEAL_FAILED"))
}

#[tauri::command]
async fn save_task_result_image(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
    title: String,
    filter_name: String,
) -> Result<Option<String>, NativeCommandError> {
    let title = validated_dialog_label(title)?;
    let filter_name = validated_dialog_label(filter_name)?;
    let source = validated_task_result_image(&app, &path)?;
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| NativeCommandError::new("TASK_RESULT_IMAGE_INVALID"))?;
    let destination = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title(&title)
        .set_file_name(file_name)
        .add_filter(&filter_name, &["png", "jpg", "jpeg"])
        .save_file()
        .await;
    let Some(destination) = destination else {
        return Ok(None);
    };
    let destination = destination.path().to_path_buf();
    let saved_path = destination.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || copy_task_result_image(&source, &destination))
        .await
        .map_err(|_| NativeCommandError::new("TASK_RESULT_IMAGE_SAVE_FAILED"))??;
    Ok(Some(saved_path))
}

fn validated_dialog_label(value: String) -> Result<String, NativeCommandError> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err(NativeCommandError::new("TASK_DIALOG_COPY_INVALID"));
    }
    Ok(value.to_string())
}

fn copy_task_result_image(
    source: &std::path::Path,
    destination: &std::path::Path,
) -> Result<(), NativeCommandError> {
    if destination
        .parent()
        .filter(|parent| parent.is_dir())
        .is_none()
    {
        return Err(NativeCommandError::new(
            "TASK_RESULT_IMAGE_SAVE_DESTINATION_INVALID",
        ));
    }
    if std::fs::canonicalize(destination)
        .ok()
        .as_deref()
        .is_some_and(|resolved| resolved == source)
    {
        return Ok(());
    }
    std::fs::copy(source, destination)
        .map(|_| ())
        .map_err(|_| NativeCommandError::new("TASK_RESULT_IMAGE_SAVE_FAILED"))
}

fn validated_task_result_image(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<std::path::PathBuf, NativeCommandError> {
    let source = std::fs::canonicalize(path)
        .map_err(|_| NativeCommandError::new("TASK_RESULT_IMAGE_UNAVAILABLE"))?;
    let artifact_root = platform::artifact_image_root(app)
        .map_err(|_| NativeCommandError::new("TASK_RESULT_IMAGE_UNAVAILABLE"))?;
    let artifact_root = std::fs::canonicalize(&artifact_root)
        .map_err(|_| NativeCommandError::new("TASK_RESULT_IMAGE_UNAVAILABLE"))?;
    let profile_root = platform::paths(app)
        .map_err(|_| NativeCommandError::new("TASK_RESULT_IMAGE_UNAVAILABLE"))?
        .profile_root;
    let profile_root = std::fs::canonicalize(profile_root)
        .map_err(|_| NativeCommandError::new("TASK_RESULT_IMAGE_UNAVAILABLE"))?;
    if !artifact_root.starts_with(&profile_root)
        || !source.starts_with(&artifact_root)
        || !source.is_file()
    {
        return Err(NativeCommandError::new("TASK_RESULT_IMAGE_OUTSIDE_SCOPE"));
    }
    match source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png" | "jpg" | "jpeg") => Ok(source),
        _ => Err(NativeCommandError::new("TASK_RESULT_IMAGE_UNSUPPORTED")),
    }
}

#[cfg(test)]
mod local_logout_tests {
    use super::*;
    #[test]
    fn native_command_errors_serialize_as_stable_codes_only() {
        let value =
            serde_json::to_value(NativeCommandError::new("TASK_RESULT_IMAGE_OPEN_FAILED")).unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "code": "TASK_RESULT_IMAGE_OPEN_FAILED" })
        );
    }

    #[test]
    fn release_panel_diagnostics_only_keep_critical_levels() {
        assert!(should_persist_panel_diagnostic_for(false, "debug"));
        assert!(!should_persist_panel_diagnostic_for(true, "debug"));
        assert!(!should_persist_panel_diagnostic_for(true, "info"));
        assert!(should_persist_panel_diagnostic_for(true, "warn"));
        assert!(should_persist_panel_diagnostic_for(true, "error"));
    }

    #[test]
    fn panel_diagnostics_accept_only_bounded_token_fields() {
        let valid = PanelDiagnosticEntry {
            occurred_at: "2026-08-14T10:00:00.000Z".to_string(),
            level: "warn".to_string(),
            event: "panel.dismiss.deferred".to_string(),
            fields: BTreeMap::from([
                (
                    "surface".to_string(),
                    serde_json::Value::String("task".to_string()),
                ),
                ("busy".to_string(), serde_json::Value::Bool(true)),
            ]),
        };
        let line = format_panel_diagnostic(&valid).unwrap();
        assert!(line.contains("event=panel.dismiss.deferred"));
        assert!(line.contains("surface=\"task\""));

        let mut invalid = valid;
        invalid.fields.insert(
            "detail".to_string(),
            serde_json::Value::String("user supplied text is rejected".to_string()),
        );
        assert!(format_panel_diagnostic(&invalid).is_err());
    }
}
