use std::{
    ptr::NonNull,
    sync::atomic::{AtomicU64, AtomicU8, Ordering},
    time::Duration,
};

use block2::RcBlock;
use objc2::{msg_send, rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{
    NSApplicationDidChangeScreenParametersNotification, NSColor, NSMainMenuWindowLevel, NSPanel,
    NSScreen, NSWindowCollectionBehavior, NSWindowDidChangeScreenNotification, NSWindowStyleMask,
    NSWorkspace, NSWorkspaceActiveSpaceDidChangeNotification,
};
use objc2_foundation::{
    NSNotification, NSNotificationCenter, NSNotificationName, NSOperationQueue, NSPoint, NSRect,
    NSSize,
};
use tauri::{AppHandle, Manager, WebviewWindow, Wry};
use tauri_nspanel::WebviewWindowExt;

use crate::window::{size_for_mode_on_monitor, IslandMode, MonitorInfo};

const ISLAND_LABEL: &str = "island";
const BOTTOM_CORNER_MASK: usize = 3;
static CURRENT_MODE: AtomicU8 = AtomicU8::new(1);
static REFRESH_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn configure(window: &WebviewWindow<Wry>) -> Result<(), String> {
    window.to_panel().map_err(|error| error.to_string())?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    let panel = unsafe { &*(pointer.cast::<NSPanel>()) };
    panel.setStyleMask(NSWindowStyleMask::Borderless | NSWindowStyleMask::NonactivatingPanel);
    panel.setFloatingPanel(true);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setBackgroundColor(Some(&NSColor::clearColor()));
    panel.setOpaque(false);
    panel.setHasShadow(false);
    panel.setHidesOnDeactivate(false);
    panel.setLevel(NSMainMenuWindowLevel + 2);
    panel.setCollectionBehavior(
        NSWindowCollectionBehavior::CanJoinAllSpaces
            | NSWindowCollectionBehavior::FullScreenAuxiliary
            | NSWindowCollectionBehavior::Stationary
            | NSWindowCollectionBehavior::IgnoresCycle,
    );
    apply_content_clip(panel, 14.0)
}

pub fn resize_and_pin(app: &AppHandle, mode: IslandMode) -> Result<(), String> {
    CURRENT_MODE.store(mode_code(mode), Ordering::SeqCst);
    run_on_main_thread(app, move |handle| resize_and_pin_on_main(handle, mode))
}

pub fn current_screen_info(app: &AppHandle) -> Result<Option<MonitorInfo>, String> {
    run_on_main_thread(app, |handle| {
        let panel = panel_for_app(handle)?;
        let Some(mtm) = MainThreadMarker::new() else {
            return Err("Teti panel screen lookup must run on the main thread".to_owned());
        };
        let screen = resolve_target_screen(mtm, panel);
        Ok(screen.as_deref().map(screen_info))
    })
}

pub fn show(app: &AppHandle) -> Result<(), String> {
    run_on_main_thread(app, |handle| {
        panel_for_app(handle)?.orderFrontRegardless();
        Ok(())
    })
}

pub fn install_screen_change_observers(app: &AppHandle) -> Result<(), String> {
    let panel = panel_for_app(app)?;
    let default_center = NSNotificationCenter::defaultCenter();
    let workspace_center = NSWorkspace::sharedWorkspace().notificationCenter();

    retain_refresh_observer(
        &default_center,
        unsafe { NSApplicationDidChangeScreenParametersNotification },
        None,
        app,
    );
    retain_refresh_observer(
        &workspace_center,
        unsafe { NSWorkspaceActiveSpaceDidChangeNotification },
        None,
        app,
    );
    retain_refresh_observer(
        &default_center,
        unsafe { NSWindowDidChangeScreenNotification },
        Some(panel),
        app,
    );
    Ok(())
}

fn resize_and_pin_on_main(app: &AppHandle, mode: IslandMode) -> Result<(), String> {
    let panel = panel_for_app(app)?;
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| "Teti panel positioning must run on the main thread".to_owned())?;
    let screen = resolve_target_screen(mtm, panel)
        .ok_or_else(|| "No macOS screen is available".to_owned())?;
    let info = screen_info(&screen);
    let base = size_for_mode_on_monitor(mode, info.has_notch);
    let safe_top = if info.has_notch {
        info.safe_top_inset
    } else {
        0.0
    };
    let height = panel_height(mode, base.height, safe_top, info.has_notch);
    let frame = screen.frame();
    let target = NSRect::new(
        NSPoint::new(
            frame.origin.x + (frame.size.width - base.width) / 2.0,
            frame.origin.y + frame.size.height - height,
        ),
        NSSize::new(base.width, height),
    );

    // WebKit and AppKit do not commit their resize frames atomically. Animating only the
    // native panel collapse can briefly stretch the expanded blue surface after the DOM
    // has already switched to the idle face, so keep the panel resize deterministic.
    panel.setFrame_display_animate(target, true, false);
    panel.setHasShadow(!matches!(mode, IslandMode::Hidden | IslandMode::Idle));
    let accepts_input = matches!(mode, IslandMode::Onboarding | IslandMode::Error);
    panel.setBecomesKeyOnlyIfNeeded(!accepts_input);
    apply_content_clip(
        panel,
        if matches!(mode, IslandMode::Hidden | IslandMode::Idle) {
            if info.has_notch {
                9.0
            } else {
                12.0
            }
        } else {
            28.0
        },
    )?;
    if accepts_input {
        panel.makeKeyAndOrderFront(None);
    } else if mode != IslandMode::Hidden {
        panel.orderFrontRegardless();
    }
    Ok(())
}

fn panel_for_app(app: &AppHandle) -> Result<&NSPanel, String> {
    let window = app
        .get_webview_window(ISLAND_LABEL)
        .ok_or_else(|| "Teti island window is not available".to_owned())?;
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    Ok(unsafe { &*(pointer.cast::<NSPanel>()) })
}

fn resolve_target_screen(mtm: MainThreadMarker, panel: &NSPanel) -> Option<Retained<NSScreen>> {
    panel
        .screen()
        .or_else(|| NSScreen::mainScreen(mtm))
        .or_else(|| NSScreen::screens(mtm).firstObject())
}

fn screen_info(screen: &NSScreen) -> MonitorInfo {
    let frame = screen.frame();
    let visible = screen.visibleFrame();
    let left = screen.auxiliaryTopLeftArea();
    let right = screen.auxiliaryTopRightArea();
    let safe_top = screen.safeAreaInsets().top.max(0.0);
    let menu_bar_height =
        (frame.origin.y + frame.size.height - visible.origin.y - visible.size.height).max(0.0);
    let has_notch = left.size.width > 0.0 || right.size.width > 0.0;
    let notch_width = if has_notch {
        let candidate = frame.size.width - left.size.width - right.size.width;
        resolved_notch_width(frame.size.width, candidate)
    } else {
        0.0
    };
    let notch_height = if has_notch {
        safe_top.max(menu_bar_height).max(32.0)
    } else {
        0.0
    };

    MonitorInfo {
        x: frame.origin.x.round() as i32,
        y: frame.origin.y.round() as i32,
        width: frame.size.width.round().max(0.0) as u32,
        height: frame.size.height.round().max(0.0) as u32,
        scale_factor: screen.backingScaleFactor(),
        has_notch,
        notch_width,
        notch_height,
        safe_top_inset: if has_notch {
            safe_top.max(notch_height)
        } else {
            0.0
        },
        menu_bar_height,
    }
}

fn resolved_notch_width(screen_width: f64, candidate: f64) -> f64 {
    if candidate <= 0.0 || candidate > screen_width * 0.5 {
        (screen_width * 0.14).clamp(180.0, 260.0)
    } else {
        candidate
    }
}

fn panel_height(mode: IslandMode, base_height: f64, safe_top: f64, has_notch: bool) -> f64 {
    if has_notch
        && matches!(
            mode,
            IslandMode::Onboarding | IslandMode::Processing | IslandMode::Error
        )
    {
        return base_height;
    }

    base_height + safe_top
}

fn apply_content_clip(panel: &NSPanel, radius: f64) -> Result<(), String> {
    let content_view = panel
        .contentView()
        .ok_or_else(|| "Teti panel content view is unavailable".to_owned())?;
    content_view.setWantsLayer(true);
    let layer: *mut AnyObject = unsafe { msg_send![&*content_view, layer] };
    let layer = unsafe { layer.as_ref() }
        .ok_or_else(|| "Teti panel content layer is unavailable".to_owned())?;
    unsafe {
        let _: () = msg_send![layer, setCornerRadius: radius];
        let _: () = msg_send![layer, setMaskedCorners: BOTTOM_CORNER_MASK];
        let _: () = msg_send![layer, setMasksToBounds: true];
    }
    Ok(())
}

fn retain_refresh_observer(
    center: &NSNotificationCenter,
    name: &NSNotificationName,
    object: Option<&AnyObject>,
    app: &AppHandle,
) {
    let handle = app.clone();
    let block: RcBlock<dyn Fn(NonNull<NSNotification>)> = RcBlock::new(move |_| {
        schedule_refresh(handle.clone());
    });
    let observer = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(name),
            object,
            Some(&NSOperationQueue::mainQueue()),
            &block,
        )
    };
    let _ = Retained::into_raw(observer);
}

fn schedule_refresh(app: AppHandle) {
    let generation = REFRESH_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(150));
        if REFRESH_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        let mode = mode_from_code(CURRENT_MODE.load(Ordering::SeqCst));
        let main_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            let _ = resize_and_pin_on_main(&main_app, mode);
        });
    });
}

fn run_on_main_thread<T, F>(app: &AppHandle, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&AppHandle) -> Result<T, String> + Send + 'static,
{
    if MainThreadMarker::new().is_some() {
        return operation(app);
    }

    let (sender, receiver) = std::sync::mpsc::sync_channel(1);
    let main_app = app.clone();
    app.run_on_main_thread(move || {
        let _ = sender.send(operation(&main_app));
    })
    .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "Timed out while updating the Teti panel".to_owned())?
}

const fn mode_code(mode: IslandMode) -> u8 {
    match mode {
        IslandMode::Hidden => 0,
        IslandMode::Idle => 1,
        IslandMode::Onboarding => 2,
        IslandMode::Processing => 3,
        IslandMode::Error => 4,
        IslandMode::Ready => 5,
    }
}

const fn mode_from_code(code: u8) -> IslandMode {
    match code {
        0 => IslandMode::Hidden,
        2 => IslandMode::Onboarding,
        3 => IslandMode::Processing,
        4 => IslandMode::Error,
        5 => IslandMode::Ready,
        _ => IslandMode::Idle,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notch_width_fallback_matches_legacy_bounds() {
        assert_eq!(resolved_notch_width(900.0, 0.0), 180.0);
        assert_eq!(resolved_notch_width(1440.0, 220.0), 220.0);
        assert_eq!(resolved_notch_width(2560.0, 1800.0), 260.0);
    }

    #[test]
    fn content_clip_uses_only_bottom_corners() {
        assert_eq!(BOTTOM_CORNER_MASK, 0b0011);
    }

    #[test]
    fn expanded_notch_modes_reclaim_the_camera_row() {
        assert_eq!(
            panel_height(IslandMode::Onboarding, 352.0, 32.0, true),
            352.0
        );
        assert_eq!(
            panel_height(IslandMode::Processing, 300.0, 32.0, true),
            300.0
        );
        assert_eq!(panel_height(IslandMode::Idle, 18.0, 32.0, true), 50.0);
        assert_eq!(panel_height(IslandMode::Ready, 150.0, 32.0, true), 182.0);
        assert_eq!(
            panel_height(IslandMode::Onboarding, 352.0, 0.0, false),
            352.0
        );
    }
}
