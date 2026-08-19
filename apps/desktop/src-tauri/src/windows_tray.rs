use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};
use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;

use crate::{lifecycle_bridge, platform};

const WINDOWS_TRAY_SHOW_ID: &str = "teti-tray-show";
const WINDOWS_TRAY_QUIT_ID: &str = "teti-tray-quit";
const WINDOWS_LOCALE_CAPACITY: usize = 85;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrayLabels {
    show: &'static str,
    quit: &'static str,
}

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let labels = tray_labels(app.handle());
    let show = MenuItem::with_id(app, WINDOWS_TRAY_SHOW_ID, labels.show, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, WINDOWS_TRAY_QUIT_ID, labels.quit, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::with_id("teti")
        .tooltip("Teti")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            WINDOWS_TRAY_SHOW_ID => show_island(app, "tray-menu"),
            WINDOWS_TRAY_QUIT_ID => {
                lifecycle_bridge::append_sanitized_log_line(
                    "desktop",
                    "event=tray.quit state=requested platform=windows",
                );
                app.state::<lifecycle_bridge::LifecycleBridge>().shutdown();
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_island(tray.app_handle(), "tray-left-click");
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        tray = tray.icon(icon);
    }
    tray.build(app)?;
    Ok(())
}

fn show_island(app: &tauri::AppHandle, reason: &str) {
    if let Some(window) = app.get_webview_window("island") {
        let _ = window.show();
        let _ = window.set_focus();
    }
    lifecycle_bridge::append_sanitized_log_line(
        "desktop",
        &format!("event=tray.show state=requested platform=windows reason={reason}"),
    );
    let _ = app.emit("teti://dock-activate", ());
}

fn tray_labels(app: &tauri::AppHandle) -> TrayLabels {
    let preference = platform::read_locale_preference(app).ok().flatten();
    labels_for(preference.as_deref(), user_locale().as_deref())
}

fn labels_for(preference: Option<&str>, user_locale: Option<&str>) -> TrayLabels {
    let use_chinese = match preference {
        Some("zh-Hans") => true,
        Some("en") => false,
        _ => user_locale.is_some_and(|locale| locale.to_ascii_lowercase().starts_with("zh")),
    };
    if use_chinese {
        TrayLabels {
            show: "显示 Teti",
            quit: "退出 Teti",
        }
    } else {
        TrayLabels {
            show: "Show Teti",
            quit: "Quit Teti",
        }
    }
}

fn user_locale() -> Option<String> {
    let mut buffer = [0u16; WINDOWS_LOCALE_CAPACITY];
    let length = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    if length <= 1 {
        return None;
    }
    String::from_utf16(&buffer[..length as usize - 1]).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_labels_follow_preference_then_windows_locale() {
        assert_eq!(labels_for(Some("zh-Hans"), Some("en-US")).show, "显示 Teti");
        assert_eq!(labels_for(Some("en"), Some("zh-CN")).quit, "Quit Teti");
        assert_eq!(labels_for(Some("auto"), Some("zh-CN")).quit, "退出 Teti");
        assert_eq!(labels_for(None, Some("en-US")).show, "Show Teti");
    }
}
