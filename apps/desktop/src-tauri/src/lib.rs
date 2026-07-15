mod lifecycle_bridge;
mod window;

pub fn run() {
    tauri::Builder::default()
        .manage(lifecycle_bridge::LifecycleBridge::default())
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
        .run(tauri::generate_context!())
        .expect("failed to run Teti Desktop");
}
