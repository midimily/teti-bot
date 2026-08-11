mod lifecycle_bridge;
#[cfg(target_os = "macos")]
mod macos_panel;
mod window;

use serde::Serialize;
#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalProfileLogoutResult {
    cleared: bool,
    server_data_deleted: bool,
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(lifecycle_bridge::LifecycleBridge::default());
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());

    let app = builder
        .setup(|app| {
            window::create_island_window(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            lifecycle_bridge::lifecycle_request,
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
async fn logout_local_profile(
    app: tauri::AppHandle,
    bridge: tauri::State<'_, lifecycle_bridge::LifecycleBridge>,
) -> Result<LocalProfileLogoutResult, String> {
    lifecycle_bridge::append_sanitized_log_line(
        "desktop",
        "event=local-profile.logout state=requested",
    );
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not resolve the local Teti profile: {error}"))?;
    let profile = local_teti_profile_path(&home)?;
    let bridge = bridge.inner().clone();
    let clear_result = tauri::async_runtime::spawn_blocking(move || {
        bridge.shutdown_for_local_logout();
        remove_local_teti_profile(&profile)
    })
    .await
    .map_err(|error| format!("Could not stop the local Teti Runtime: {error}"));
    let cleared = match clear_result {
        Ok(Ok(cleared)) => cleared,
        Ok(Err(error)) => {
            lifecycle_bridge::append_sanitized_log_line(
                "desktop",
                "event=local-profile.logout state=failed stage=profile-clear",
            );
            return Err(error);
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
fn restart_application(app: tauri::AppHandle) -> Result<(), String> {
    lifecycle_bridge::append_sanitized_log_line(
        "desktop",
        "event=local-profile.logout state=restarting",
    );
    app.restart()
}

fn local_teti_profile_path(home: &std::path::Path) -> Result<std::path::PathBuf, String> {
    if !home.is_absolute() || home.parent().is_none() {
        return Err("Refusing to resolve an unsafe local Teti profile root.".to_string());
    }
    let profile = home.join(".teti");
    if profile.parent() != Some(home) || profile.file_name() != Some(std::ffi::OsStr::new(".teti"))
    {
        return Err("Refusing to clear an unsafe local Teti profile target.".to_string());
    }
    Ok(profile)
}

fn remove_local_teti_profile(profile: &std::path::Path) -> Result<bool, String> {
    let metadata = match std::fs::symlink_metadata(profile) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Could not inspect the local Teti profile: {error}")),
    };
    let result = if metadata.is_dir() && !metadata.file_type().is_symlink() {
        std::fs::remove_dir_all(profile)
    } else {
        std::fs::remove_file(profile)
    };
    result
        .map(|_| true)
        .map_err(|error| format!("Could not clear the local Teti profile: {error}"))
}

#[tauri::command]
async fn pick_task_images(window: tauri::WebviewWindow) -> Result<Vec<String>, String> {
    let files = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("选择任务图片")
        .add_filter("Images", &["png", "jpg", "jpeg"])
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
async fn open_task_result_image(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let source = validated_task_result_image(&app, &path)?;
    run_macos_open([source.as_os_str()])
}

#[tauri::command]
async fn reveal_task_result_image(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let source = validated_task_result_image(&app, &path)?;
    run_macos_open([std::ffi::OsStr::new("-R"), source.as_os_str()])
}

#[tauri::command]
async fn save_task_result_image(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    path: String,
) -> Result<Option<String>, String> {
    let source = validated_task_result_image(&app, &path)?;
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Task result image filename is invalid.".to_string())?;
    let destination = rfd::AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("保存结果图片")
        .set_file_name(file_name)
        .add_filter("Image", &["png", "jpg", "jpeg"])
        .save_file()
        .await;
    let Some(destination) = destination else {
        return Ok(None);
    };
    std::fs::copy(&source, destination.path())
        .map_err(|error| format!("Failed to save Task result image: {error}"))?;
    Ok(Some(destination.path().to_string_lossy().into_owned()))
}

#[cfg(target_os = "macos")]
fn run_macos_open<const N: usize>(args: [&std::ffi::OsStr; N]) -> Result<(), String> {
    let status = std::process::Command::new("/usr/bin/open")
        .args(args)
        .status()
        .map_err(|error| format!("Failed to open Task result image: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err("macOS could not open the Task result image.".to_string())
    }
}

#[cfg(not(target_os = "macos"))]
fn run_macos_open<const N: usize>(_args: [&std::ffi::OsStr; N]) -> Result<(), String> {
    Err("Task result image actions are currently available on macOS only.".to_string())
}

fn validated_task_result_image(
    app: &tauri::AppHandle,
    path: &str,
) -> Result<std::path::PathBuf, String> {
    let source =
        std::fs::canonicalize(path).map_err(|_| "Task result image is unavailable.".to_string())?;
    let artifact_root = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not resolve the Teti data directory: {error}"))?
        .join(".teti")
        .join("store-v2")
        .join("task-attachments")
        .join("artifact");
    let artifact_root = std::fs::canonicalize(artifact_root)
        .map_err(|_| "Teti Task Artifact storage is unavailable.".to_string())?;
    if !source.starts_with(&artifact_root) || !source.is_file() {
        return Err("Only verified Teti Task result images can be opened or exported.".to_string());
    }
    match source.extension().and_then(|extension| extension.to_str()) {
        Some("png" | "jpg" | "jpeg") => Ok(source),
        _ => Err("Task result image type is unsupported.".to_string()),
    }
}

#[cfg(test)]
mod local_logout_tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn local_profile_target_is_exactly_dot_teti_under_home() {
        assert_eq!(
            local_teti_profile_path(Path::new("/Users/teti-test")).unwrap(),
            Path::new("/Users/teti-test/.teti")
        );
        assert!(local_teti_profile_path(Path::new("/")).is_err());
        assert!(local_teti_profile_path(Path::new("relative-home")).is_err());
    }
}
