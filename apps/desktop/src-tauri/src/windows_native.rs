use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{AppHandle, Emitter, WebviewWindow};
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMECRITICAL, PBT_APMRESUMESUSPEND, PBT_APMSUSPEND,
            WM_CLOSE, WM_DISPLAYCHANGE, WM_DPICHANGED, WM_NCDESTROY, WM_POWERBROADCAST,
            WM_SETTINGCHANGE,
        },
    },
};

const TETI_WINDOW_SUBCLASS_ID: usize = 0x5445_5449;
static SYSTEM_SLEEPING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PhysicalWorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub fn install_native_window_events(app: &AppHandle, window: &WebviewWindow) -> Result<(), String> {
    let hwnd = raw_hwnd(window)?;
    let callback_data = Box::into_raw(Box::new(app.clone())) as usize;
    let installed = unsafe {
        SetWindowSubclass(
            hwnd,
            Some(teti_window_subclass_proc),
            TETI_WINDOW_SUBCLASS_ID,
            callback_data,
        )
    };
    if installed == 0 {
        unsafe {
            drop(Box::from_raw(callback_data as *mut AppHandle));
        }
        return Err("Could not install the Teti Windows message observer.".to_string());
    }
    Ok(())
}

pub fn work_area(window: &WebviewWindow) -> Result<PhysicalWorkArea, String> {
    let hwnd = raw_hwnd(window)?;
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
    if monitor.is_null() {
        return Err("No Windows monitor is available for the Teti companion.".to_string());
    }

    let mut info = MONITORINFO {
        cbSize: std::mem::size_of::<MONITORINFO>() as u32,
        ..Default::default()
    };
    if unsafe { GetMonitorInfoW(monitor, &mut info) } == 0 {
        return Err("Could not resolve the Windows monitor work area.".to_string());
    }

    let width = info.rcWork.right.saturating_sub(info.rcWork.left) as u32;
    let height = info.rcWork.bottom.saturating_sub(info.rcWork.top) as u32;
    if width == 0 || height == 0 {
        return Err("The Windows monitor work area is invalid.".to_string());
    }
    Ok(PhysicalWorkArea {
        x: info.rcWork.left,
        y: info.rcWork.top,
        width,
        height,
    })
}

fn raw_hwnd(window: &WebviewWindow) -> Result<HWND, String> {
    window
        .hwnd()
        .map(|hwnd| hwnd.0 as HWND)
        .map_err(|error| error.to_string())
}

unsafe extern "system" fn teti_window_subclass_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    callback_data: usize,
) -> LRESULT {
    let app = &*(callback_data as *const AppHandle);
    match message {
        WM_CLOSE => {
            crate::lifecycle_bridge::append_sanitized_log_line(
                "desktop",
                "event=window.wm_close state=prevented platform=windows",
            );
            return 0;
        }
        WM_POWERBROADCAST => handle_power_broadcast(app, wparam as u32),
        WM_DISPLAYCHANGE | WM_DPICHANGED | WM_SETTINGCHANGE => {
            crate::window::schedule_non_macos_reposition(app.clone());
        }
        WM_NCDESTROY => {
            RemoveWindowSubclass(
                hwnd,
                Some(teti_window_subclass_proc),
                TETI_WINDOW_SUBCLASS_ID,
            );
            let result = DefSubclassProc(hwnd, message, wparam, lparam);
            drop(Box::from_raw(callback_data as *mut AppHandle));
            return result;
        }
        _ => {}
    }
    DefSubclassProc(hwnd, message, wparam, lparam)
}

fn handle_power_broadcast(app: &AppHandle, event: u32) {
    match event {
        PBT_APMSUSPEND => {
            if !SYSTEM_SLEEPING.swap(true, Ordering::SeqCst) {
                let _ = app.emit("teti://system-sleep", ());
            }
        }
        PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMECRITICAL | PBT_APMRESUMESUSPEND => {
            if SYSTEM_SLEEPING.swap(false, Ordering::SeqCst) {
                let _ = app.emit("teti://system-wake", ());
                crate::window::schedule_non_macos_reposition(app.clone());
            }
        }
        _ => {}
    }
}
