mod lifecycle_bridge;
#[cfg(target_os = "macos")]
mod macos_panel;
mod window;

#[cfg(target_os = "macos")]
use tauri::Emitter;
use tauri::Manager;

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
