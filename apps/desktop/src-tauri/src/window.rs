use serde::{Deserialize, Serialize};
use tauri::{
    App, AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const ISLAND_LABEL: &str = "island";

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum IslandMode {
    Hidden,
    Idle,
    Onboarding,
    Processing,
    Error,
    Ready,
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
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IslandSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonitorFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub scale_factor: f64,
}

pub fn create_island_window(app: &App) -> tauri::Result<WebviewWindow> {
    let size = size_for_mode(IslandMode::Idle);
    let window = WebviewWindowBuilder::new(app, ISLAND_LABEL, WebviewUrl::App("index.html".into()))
        .title("Teti")
        .inner_size(size.width, size.height)
        .min_inner_size(132.0, 34.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(false)
        .visible(false)
        .build()?;

    position_window_top_center(&window, size, 8.0)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
    window.show()?;
    Ok(window)
}

#[tauri::command]
pub fn set_island_mode(app: AppHandle, mode: IslandMode, reason: String) -> Result<(), String> {
    validate_reason(&reason)?;
    let window = island_window(&app)?;
    let size = size_for_mode(mode);

    window
        .set_size(LogicalSize::new(size.width, size.height))
        .map_err(|error| error.to_string())?;
    position_window_top_center(&window, size, top_inset_for_mode(mode))?;

    match mode {
        IslandMode::Hidden => window.hide().map_err(|error| error.to_string())?,
        _ => window.show().map_err(|error| error.to_string())?,
    }

    Ok(())
}

#[tauri::command]
pub fn position_island(app: AppHandle, geometry: GeometryInput) -> Result<(), String> {
    let window = island_window(&app)?;
    let current_size = window.inner_size().map_err(|error| error.to_string())?;
    let scale_factor = window.scale_factor().map_err(|error| error.to_string())?;
    let width = geometry
        .width
        .unwrap_or(current_size.width as f64 / scale_factor);
    let height = geometry
        .height
        .unwrap_or(current_size.height as f64 / scale_factor);
    let top_inset = geometry.top_inset.unwrap_or(8.0);
    validate_size(width, height)?;
    position_window_top_center(&window, IslandSize { width, height }, top_inset)
}

#[tauri::command]
pub fn show_island(app: AppHandle, reason: String) -> Result<(), String> {
    validate_reason(&reason)?;
    island_window(&app)?
        .show()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn hide_island(app: AppHandle, reason: String) -> Result<(), String> {
    validate_reason(&reason)?;
    island_window(&app)?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn current_monitor_info(app: AppHandle) -> Result<Option<MonitorInfo>, String> {
    let window = island_window(&app)?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?;
    Ok(monitor.map(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        MonitorInfo {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            scale_factor: monitor.scale_factor(),
        }
    }))
}

pub fn size_for_mode(mode: IslandMode) -> IslandSize {
    match mode {
        IslandMode::Hidden | IslandMode::Idle => IslandSize {
            width: 164.0,
            height: 38.0,
        },
        IslandMode::Onboarding | IslandMode::Error => IslandSize {
            width: 430.0,
            height: 214.0,
        },
        IslandMode::Processing => IslandSize {
            width: 390.0,
            height: 172.0,
        },
        IslandMode::Ready => IslandSize {
            width: 360.0,
            height: 150.0,
        },
    }
}

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

fn top_inset_for_mode(mode: IslandMode) -> f64 {
    match mode {
        IslandMode::Hidden | IslandMode::Idle => 6.0,
        _ => 10.0,
    }
}

fn position_window_top_center(
    window: &WebviewWindow,
    size: IslandSize,
    top_inset: f64,
) -> Result<(), String> {
    validate_size(size.width, size.height)?;
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let frame = monitor_frame(&monitor);
        let position = top_center_position(frame, size, top_inset);
        window
            .set_position(position)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

fn monitor_frame(monitor: &tauri::Monitor) -> MonitorFrame {
    let position: &PhysicalPosition<i32> = monitor.position();
    let size: &PhysicalSize<u32> = monitor.size();
    let scale = monitor.scale_factor();

    MonitorFrame {
        x: position.x as f64 / scale,
        y: position.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
        scale_factor: scale,
    }
}

fn island_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window(ISLAND_LABEL)
        .ok_or_else(|| "Teti island window is not available.".to_string())
}

fn validate_size(width: f64, height: f64) -> Result<(), String> {
    if !width.is_finite() || !height.is_finite() || width < 120.0 || height < 30.0 {
        return Err("Invalid island geometry.".to_string());
    }
    if width > 640.0 || height > 360.0 {
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
                width: 164.0,
                height: 38.0
            }
        );
        assert_eq!(
            size_for_mode(IslandMode::Onboarding),
            IslandSize {
                width: 430.0,
                height: 214.0
            }
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
                width: 430.0,
                height: 214.0,
            },
            10.0,
        );

        assert_eq!(position.x, 505.0);
        assert_eq!(position.y, 10.0);
    }

    #[test]
    fn size_validation_rejects_large_windows() {
        assert!(validate_size(700.0, 200.0).is_err());
        assert!(validate_size(430.0, 214.0).is_ok());
    }
}
