use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "macos"))]
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use tauri::{
    AppHandle, LogicalPosition, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

#[cfg(not(target_os = "macos"))]
use tauri::LogicalSize;

#[cfg(target_os = "macos")]
use crate::macos_panel;
use crate::native_error::NativeCommandError;

const ISLAND_LABEL: &str = "island";
pub const CONNECTION_DETAIL_BASE_HEIGHT: f64 = 352.0;
pub const CONNECTION_DETAIL_BOTTOM_MARGIN: f64 = 24.0;
pub const MAX_ISLAND_HEIGHT: f64 = 1_200.0;
#[cfg(not(target_os = "macos"))]
static CURRENT_MODE: AtomicU8 = AtomicU8::new(1);
#[cfg(not(target_os = "macos"))]
static REPOSITION_GENERATION: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IslandMode {
    Hidden,
    Idle,
    Onboarding,
    ConnectionDetail,
    Processing,
    Error,
    Ready,
    Task,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeometryInput {
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub top_inset: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorInfo {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
    pub has_notch: bool,
    pub notch_width: f64,
    pub notch_height: f64,
    pub safe_top_inset: f64,
    pub menu_bar_height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IslandSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct MonitorFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhysicalMonitorFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor: f64,
}

pub fn create_island_window(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let initial_mode = initial_island_mode();
    let size = size_for_mode(initial_mode);
    #[cfg(not(target_os = "macos"))]
    CURRENT_MODE.store(mode_code(initial_mode), Ordering::SeqCst);
    let builder =
        WebviewWindowBuilder::new(app, ISLAND_LABEL, WebviewUrl::App("index.html".into()))
            .title("Teti")
            .inner_size(size.width, size.height)
            .min_inner_size(32.0, 18.0)
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false);
    #[cfg(target_os = "windows")]
    let builder = builder.closable(false);
    let window = builder.build()?;

    #[cfg(target_os = "macos")]
    {
        macos_panel::configure(&window).map_err(std::io::Error::other)?;
        macos_panel::resize_and_pin(app, IslandMode::Idle).map_err(std::io::Error::other)?;
        macos_panel::install_screen_change_observers(app).map_err(std::io::Error::other)?;
    }
    #[cfg(not(target_os = "macos"))]
    position_window_top_center(&window, size, top_inset_for_mode(initial_mode))
        .map_err(std::io::Error::other)?;
    #[cfg(target_os = "windows")]
    crate::windows_native::install_native_window_events(app, &window)
        .map_err(std::io::Error::other)?;
    #[cfg(not(target_os = "macos"))]
    window.show()?;
    #[cfg(target_os = "windows")]
    let _ = window.set_focus();
    Ok(window)
}

const fn initial_island_mode() -> IslandMode {
    #[cfg(target_os = "windows")]
    {
        IslandMode::Onboarding
    }
    #[cfg(not(target_os = "windows"))]
    {
        IslandMode::Idle
    }
}

#[tauri::command]
pub fn set_island_mode(
    app: AppHandle,
    mode: IslandMode,
    reason: String,
) -> Result<(), NativeCommandError> {
    validate_reason(&reason)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_REASON_INVALID"))?;
    let window =
        island_window(&app).map_err(|_| NativeCommandError::new("NATIVE_WINDOW_UNAVAILABLE"))?;
    #[cfg(target_os = "macos")]
    macos_panel::resize_and_pin(&app, mode)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_RESIZE_FAILED"))?;
    #[cfg(not(target_os = "macos"))]
    {
        CURRENT_MODE.store(mode_code(mode), Ordering::SeqCst);
        let size = size_for_mode(mode);
        window
            .set_size(LogicalSize::new(size.width, size.height))
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_RESIZE_FAILED"))?;
        position_window_top_center(&window, size, top_inset_for_mode(mode))
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_POSITION_FAILED"))?;
    }

    if mode == IslandMode::Hidden {
        window
            .hide()
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_HIDE_FAILED"))?;
    }
    #[cfg(not(target_os = "macos"))]
    if mode != IslandMode::Hidden {
        window
            .show()
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_SHOW_FAILED"))?;
        if mode_accepts_input(mode) {
            window
                .set_focus()
                .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_FOCUS_FAILED"))?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn set_connection_detail_height(
    app: AppHandle,
    height: f64,
    reason: String,
) -> Result<(), NativeCommandError> {
    validate_reason(&reason)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_REASON_INVALID"))?;
    if !height.is_finite() || height <= 0.0 {
        return Err(NativeCommandError::new("NATIVE_WINDOW_GEOMETRY_INVALID"));
    }
    #[cfg(target_os = "macos")]
    return macos_panel::resize_connection_detail(&app, height)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_RESIZE_FAILED"));

    #[cfg(not(target_os = "macos"))]
    {
        let window = island_window(&app)
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_UNAVAILABLE"))?;
        let monitor_height = available_monitor_height(&window)
            .map_err(|_| NativeCommandError::new("NATIVE_MONITOR_QUERY_FAILED"))?;
        let height = connection_detail_height(height, monitor_height);
        let size = IslandSize {
            width: 500.0,
            height,
        };
        validate_size(size.width, size.height)
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_GEOMETRY_INVALID"))?;
        window
            .set_size(LogicalSize::new(size.width, size.height))
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_RESIZE_FAILED"))?;
        position_window_top_center(
            &window,
            size,
            top_inset_for_mode(IslandMode::ConnectionDetail),
        )
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_POSITION_FAILED"))
    }
}

#[tauri::command]
pub fn position_island(app: AppHandle, geometry: GeometryInput) -> Result<(), NativeCommandError> {
    let window =
        island_window(&app).map_err(|_| NativeCommandError::new("NATIVE_WINDOW_UNAVAILABLE"))?;
    let current_size = window
        .inner_size()
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_GEOMETRY_UNAVAILABLE"))?;
    let scale_factor = window
        .scale_factor()
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_GEOMETRY_UNAVAILABLE"))?;
    let width = geometry
        .width
        .unwrap_or(current_size.width as f64 / scale_factor);
    let height = geometry
        .height
        .unwrap_or(current_size.height as f64 / scale_factor);
    let top_inset = geometry.top_inset.unwrap_or(8.0);
    validate_size(width, height)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_GEOMETRY_INVALID"))?;
    position_window_top_center(&window, IslandSize { width, height }, top_inset)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_POSITION_FAILED"))
}

#[tauri::command]
pub fn show_island(app: AppHandle, reason: String) -> Result<(), NativeCommandError> {
    validate_reason(&reason)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_REASON_INVALID"))?;
    #[cfg(target_os = "macos")]
    return macos_panel::show(&app)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_SHOW_FAILED"));

    #[cfg(not(target_os = "macos"))]
    {
        let window = island_window(&app)
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_UNAVAILABLE"))?;
        window
            .show()
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_SHOW_FAILED"))?;
        window
            .set_focus()
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_FOCUS_FAILED"))
    }
}

#[tauri::command]
pub fn hide_island(app: AppHandle, reason: String) -> Result<(), NativeCommandError> {
    validate_reason(&reason)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_REASON_INVALID"))?;
    island_window(&app)
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_UNAVAILABLE"))?
        .hide()
        .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_HIDE_FAILED"))
}

#[tauri::command]
pub fn current_monitor_info(app: AppHandle) -> Result<Option<MonitorInfo>, NativeCommandError> {
    #[cfg(target_os = "macos")]
    return macos_panel::current_screen_info(&app)
        .map_err(|_| NativeCommandError::new("NATIVE_MONITOR_QUERY_FAILED"));

    #[cfg(not(target_os = "macos"))]
    {
        let window = island_window(&app)
            .map_err(|_| NativeCommandError::new("NATIVE_WINDOW_UNAVAILABLE"))?;
        let monitor = window
            .current_monitor()
            .map_err(|_| NativeCommandError::new("NATIVE_MONITOR_QUERY_FAILED"))?;
        Ok(monitor.map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            MonitorInfo {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
                scale_factor: monitor.scale_factor(),
                has_notch: false,
                notch_width: 0.0,
                notch_height: 0.0,
                safe_top_inset: 0.0,
                menu_bar_height: 0.0,
            }
        }))
    }
}

pub fn size_for_mode(mode: IslandMode) -> IslandSize {
    match mode {
        IslandMode::Hidden | IslandMode::Idle => IslandSize {
            width: 64.0,
            height: 24.0,
        },
        IslandMode::Onboarding | IslandMode::Error => IslandSize {
            width: 500.0,
            height: 352.0,
        },
        IslandMode::ConnectionDetail => IslandSize {
            width: 500.0,
            height: CONNECTION_DETAIL_BASE_HEIGHT,
        },
        IslandMode::Processing => IslandSize {
            width: 430.0,
            height: 300.0,
        },
        IslandMode::Ready => IslandSize {
            width: 360.0,
            height: 150.0,
        },
        IslandMode::Task => IslandSize {
            width: 600.0,
            height: 360.0,
        },
    }
}

pub fn connection_detail_height(requested: f64, monitor_height: f64) -> f64 {
    let available_height = if monitor_height.is_finite() {
        (monitor_height - CONNECTION_DETAIL_BOTTOM_MARGIN)
            .clamp(CONNECTION_DETAIL_BASE_HEIGHT, MAX_ISLAND_HEIGHT)
    } else {
        CONNECTION_DETAIL_BASE_HEIGHT
    };
    if requested.is_finite() {
        requested.clamp(CONNECTION_DETAIL_BASE_HEIGHT, available_height)
    } else {
        CONNECTION_DETAIL_BASE_HEIGHT
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn size_for_mode_on_monitor(mode: IslandMode, has_notch: bool) -> IslandSize {
    if has_notch && matches!(mode, IslandMode::Hidden | IslandMode::Idle) {
        return IslandSize {
            width: 52.0,
            height: 18.0,
        };
    }

    size_for_mode(mode)
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn top_center_position(
    frame: MonitorFrame,
    size: IslandSize,
    top_inset: f64,
) -> LogicalPosition<f64> {
    let safe_top = top_inset.max(0.0);
    let x = frame.x + ((frame.width - size.width) / 2.0).max(0.0);
    let y = frame.y + safe_top;
    LogicalPosition::new(x.round(), y.round())
}

pub fn top_center_physical_position(
    frame: PhysicalMonitorFrame,
    size: IslandSize,
    top_inset: f64,
) -> PhysicalPosition<i32> {
    let scale = if frame.scale_factor.is_finite() && frame.scale_factor > 0.0 {
        frame.scale_factor
    } else {
        1.0
    };
    let window_width = (size.width * scale).round().max(1.0) as i64;
    let frame_width = i64::from(frame.width);
    let x_offset = ((frame_width - window_width) / 2).max(0);
    let y_offset = (top_inset.max(0.0) * scale).round() as i64;
    PhysicalPosition::new(
        (i64::from(frame.x) + x_offset).clamp(i32::MIN as i64, i32::MAX as i64) as i32,
        (i64::from(frame.y) + y_offset).clamp(i32::MIN as i64, i32::MAX as i64) as i32,
    )
}

#[cfg(not(target_os = "macos"))]
fn top_inset_for_mode(mode: IslandMode) -> f64 {
    match mode {
        IslandMode::Hidden | IslandMode::Idle => 0.0,
        _ => 10.0,
    }
}

fn position_window_top_center(
    window: &WebviewWindow,
    size: IslandSize,
    top_inset: f64,
) -> Result<(), String> {
    validate_size(size.width, size.height)?;
    #[cfg(target_os = "windows")]
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;

    #[cfg(target_os = "windows")]
    let frame = crate::windows_native::work_area(window).map(|area| PhysicalMonitorFrame {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
        scale_factor,
    })?;

    #[cfg(not(target_os = "windows"))]
    let frame = {
        let monitor = window
            .current_monitor()
            .map_err(|error| error.to_string())?
            .or_else(|| window.primary_monitor().ok().flatten());
        let Some(monitor) = monitor else {
            return Ok(());
        };
        let position = monitor.position();
        let dimensions = monitor.size();
        PhysicalMonitorFrame {
            x: position.x,
            y: position.y,
            width: dimensions.width,
            height: dimensions.height,
            scale_factor: monitor.scale_factor(),
        }
    };

    let position = top_center_physical_position(frame, size, top_inset);
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;

    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn available_monitor_height(window: &WebviewWindow) -> Result<f64, String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    #[cfg(target_os = "windows")]
    {
        return crate::windows_native::work_area(window)
            .map(|area| area.height as f64 / scale.max(1.0));
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(window
            .current_monitor()
            .map_err(|error| error.to_string())?
            .map(|monitor| monitor.size().height as f64 / monitor.scale_factor())
            .unwrap_or(MAX_ISLAND_HEIGHT))
    }
}

#[cfg(not(target_os = "macos"))]
pub fn schedule_non_macos_reposition(app: AppHandle) {
    let generation = REPOSITION_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(120));
        if REPOSITION_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let mode = mode_from_code(CURRENT_MODE.load(Ordering::SeqCst));
        let main_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            let Ok(window) = island_window(&main_app) else {
                return;
            };
            let size = size_for_mode(mode);
            let _ = window.set_size(LogicalSize::new(size.width, size.height));
            let _ = position_window_top_center(&window, size, top_inset_for_mode(mode));
        });
    });
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn mode_accepts_input(mode: IslandMode) -> bool {
    matches!(
        mode,
        IslandMode::Onboarding
            | IslandMode::ConnectionDetail
            | IslandMode::Error
            | IslandMode::Task
    )
}

#[cfg(not(target_os = "macos"))]
const fn mode_code(mode: IslandMode) -> u8 {
    match mode {
        IslandMode::Hidden => 0,
        IslandMode::Idle => 1,
        IslandMode::Onboarding => 2,
        IslandMode::Processing => 3,
        IslandMode::Error => 4,
        IslandMode::Ready => 5,
        IslandMode::Task => 6,
        IslandMode::ConnectionDetail => 7,
    }
}

#[cfg(not(target_os = "macos"))]
const fn mode_from_code(code: u8) -> IslandMode {
    match code {
        0 => IslandMode::Hidden,
        2 => IslandMode::Onboarding,
        3 => IslandMode::Processing,
        4 => IslandMode::Error,
        5 => IslandMode::Ready,
        6 => IslandMode::Task,
        7 => IslandMode::ConnectionDetail,
        _ => IslandMode::Idle,
    }
}

fn island_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(ISLAND_LABEL)
        .ok_or_else(|| "Teti island window is not available.".to_string())
}

fn validate_size(width: f64, height: f64) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() || width < 32.0 || height < 18.0 {
        return Err("Invalid island geometry.".to_string());
    }
    if width > 640.0 || height > MAX_ISLAND_HEIGHT {
        return Err("Island geometry exceeds alpha bounds.".to_string());
    }
    Ok(())
}

fn validate_reason(reason: &str) -> Result<(), String> {
    if reason.len() > 80 {
        return Err("Island command reason is too long.".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_match_alpha_modes() {
        assert_eq!(
            size_for_mode(IslandMode::Idle),
            IslandSize {
                width: 64.0,
                height: 24.0
            }
        );
        assert_eq!(
            size_for_mode(IslandMode::Onboarding),
            IslandSize {
                width: 500.0,
                height: 352.0
            }
        );
        assert_eq!(
            size_for_mode(IslandMode::ConnectionDetail),
            IslandSize {
                width: 500.0,
                height: CONNECTION_DETAIL_BASE_HEIGHT
            }
        );
    }

    #[test]
    fn notched_monitor_uses_a_short_idle_tail() {
        assert_eq!(
            size_for_mode_on_monitor(IslandMode::Idle, true),
            IslandSize {
                width: 52.0,
                height: 18.0
            }
        );
        assert_eq!(
            size_for_mode_on_monitor(IslandMode::Idle, false),
            IslandSize {
                width: 64.0,
                height: 24.0
            }
        );
        assert_eq!(
            size_for_mode_on_monitor(IslandMode::Onboarding, true),
            size_for_mode(IslandMode::Onboarding)
        );
    }

    #[test]
    fn top_center_position_centers_on_monitor() {
        let position = top_center_position(
            MonitorFrame {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 900.0,
                scale_factor: 2.0,
            },
            IslandSize {
                width: 500.0,
                height: 352.0,
            },
            10.0,
        );

        assert_eq!(position.x, 470.0);
        assert_eq!(position.y, 10.0);
    }

    #[test]
    fn physical_position_keeps_mixed_dpi_monitor_coordinates() {
        let position = top_center_physical_position(
            PhysicalMonitorFrame {
                x: -2_560,
                y: 48,
                width: 2_560,
                height: 1_392,
                scale_factor: 1.5,
            },
            IslandSize {
                width: 500.0,
                height: 352.0,
            },
            10.0,
        );

        assert_eq!(position.x, -1_655);
        assert_eq!(position.y, 63);
    }

    #[test]
    fn input_modes_are_the_only_modes_that_request_focus() {
        assert!(mode_accepts_input(IslandMode::Onboarding));
        assert!(mode_accepts_input(IslandMode::ConnectionDetail));
        assert!(mode_accepts_input(IslandMode::Error));
        assert!(mode_accepts_input(IslandMode::Task));
        assert!(!mode_accepts_input(IslandMode::Idle));
        assert!(!mode_accepts_input(IslandMode::Processing));
    }

    #[test]
    fn size_validation_rejects_large_windows() {
        assert!(validate_size(700.0, 200.0).is_err());
        assert!(validate_size(500.0, 352.0).is_ok());
        assert!(validate_size(500.0, 560.0).is_ok());
        assert!(validate_size(500.0, 1_000.0).is_ok());
        assert!(validate_size(500.0, 1_201.0).is_err());
    }

    #[test]
    fn connection_detail_height_follows_content_with_screen_bounds() {
        assert_eq!(connection_detail_height(280.0, 900.0), 352.0);
        assert_eq!(connection_detail_height(480.0, 900.0), 480.0);
        assert_eq!(connection_detail_height(700.0, 900.0), 700.0);
        assert_eq!(connection_detail_height(980.0, 900.0), 876.0);
        assert_eq!(connection_detail_height(1_400.0, 1_600.0), 1_200.0);
    }
}
