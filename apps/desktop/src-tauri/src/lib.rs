mod lifecycle_bridge;
#[cfg(target_os = "macos")]
mod macos_panel;
mod window;

#[cfg(target_os = "macos")]
use tauri::Emitter;

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
            window::position_island,
            window::show_island,
            window::hide_island,
            window::current_monitor_info
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Teti Desktop");

    app.run(|handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            let _ = handle.emit("teti://dock-activate", ());
        }
    });
}
