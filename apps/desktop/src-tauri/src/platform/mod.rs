use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
mod windows_security;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum DesktopPlatform {
    Macos,
    Windows,
    Other,
}

impl DesktopPlatform {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Macos => "macos",
            Self::Windows => "windows",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[allow(dead_code)]
pub enum DesktopArchitecture {
    Arm64,
    X64,
    Other,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopShell {
    NotchPanel,
    TopCenterCompanion,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleRuntime {
    Bundled,
    Mock,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[allow(dead_code)]
pub enum ProfileSecurity {
    ProtectedAcl,
    PlatformDefault,
}

impl ProfileSecurity {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProtectedAcl => "protected-acl",
            Self::PlatformDefault => "platform-default",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPlatformInfo {
    pub platform: DesktopPlatform,
    pub architecture: DesktopArchitecture,
    pub shell: DesktopShell,
    pub lifecycle_runtime: LifecycleRuntime,
    pub supports_dock_reopen: bool,
    pub supports_native_sleep_events: bool,
    pub supports_reveal_in_file_manager: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopPlatformPaths {
    pub profile_root: PathBuf,
    pub log_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalePreferenceRecord {
    schema_version: u8,
    preference: String,
}

pub const fn info() -> DesktopPlatformInfo {
    let platform = current_platform();
    DesktopPlatformInfo {
        platform,
        architecture: current_architecture(),
        shell: match platform {
            DesktopPlatform::Macos => DesktopShell::NotchPanel,
            DesktopPlatform::Windows | DesktopPlatform::Other => DesktopShell::TopCenterCompanion,
        },
        lifecycle_runtime: match platform {
            DesktopPlatform::Macos | DesktopPlatform::Windows => LifecycleRuntime::Bundled,
            DesktopPlatform::Other => LifecycleRuntime::Mock,
        },
        supports_dock_reopen: matches!(platform, DesktopPlatform::Macos),
        supports_native_sleep_events: matches!(
            platform,
            DesktopPlatform::Macos | DesktopPlatform::Windows
        ),
        supports_reveal_in_file_manager: matches!(
            platform,
            DesktopPlatform::Macos | DesktopPlatform::Windows
        ),
    }
}

pub fn paths(app: &AppHandle) -> Result<DesktopPlatformPaths, String> {
    match current_platform() {
        DesktopPlatform::Macos => {
            let home = app.path().home_dir().map_err(|error| error.to_string())?;
            macos_paths(&home)
        }
        DesktopPlatform::Windows | DesktopPlatform::Other => {
            let local_data = app
                .path()
                .app_local_data_dir()
                .map_err(|error| error.to_string())?;
            local_data_paths(&local_data)
        }
    }
}

pub fn configure_process_environment(app: &AppHandle) -> Result<(), String> {
    let platform = info();
    let paths = paths(app)?;
    std::fs::create_dir_all(&paths.profile_root).map_err(|error| error.to_string())?;
    validate_profile_root_entry(&paths.profile_root)?;
    std::fs::create_dir_all(&paths.log_dir).map_err(|error| error.to_string())?;
    let profile_security = prepare_profile_security(&paths.profile_root)?;
    std::env::set_var("TETI_DESKTOP_PLATFORM", platform.platform.as_str());
    std::env::set_var("TETI_PROFILE_DIR", &paths.profile_root);
    std::env::set_var("TETI_DESKTOP_LOG_DIR", &paths.log_dir);
    std::env::set_var("TETI_PROFILE_SECURITY", profile_security.as_str());
    Ok(())
}

pub fn profile_security_status(app: &AppHandle) -> Result<ProfileSecurity, String> {
    let paths = paths(app)?;
    inspect_profile_security(&paths.profile_root)
}

pub fn artifact_image_root(app: &AppHandle) -> Result<PathBuf, String> {
    let paths = paths(app)?;
    artifact_image_root_for_profile(&paths.profile_root)
}

pub fn read_locale_preference(app: &AppHandle) -> Result<Option<String>, String> {
    let path = locale_preference_path_for_profile(&paths(app)?.profile_root)?;
    if !path.exists() {
        return Ok(None);
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata_is_unsafe_link(&metadata) || metadata.len() > 256 {
        return Err("Teti locale preference is not a safe bounded file.".to_string());
    }
    let record: LocalePreferenceRecord =
        serde_json::from_slice(&std::fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|_| "Teti locale preference is invalid.".to_string())?;
    validate_locale_preference_record(&record)?;
    Ok(Some(record.preference))
}

pub fn write_locale_preference(app: &AppHandle, preference: &str) -> Result<(), String> {
    validate_locale_preference(preference)?;
    let profile_root = paths(app)?.profile_root;
    validate_profile_root_entry(&profile_root)?;
    let preferences = exact_child(&profile_root, "preferences")?;
    std::fs::create_dir_all(&preferences).map_err(|error| error.to_string())?;
    let preferences_metadata =
        std::fs::symlink_metadata(&preferences).map_err(|error| error.to_string())?;
    if !preferences_metadata.is_dir() || metadata_is_unsafe_link(&preferences_metadata) {
        return Err("Teti preferences directory is unsafe.".to_string());
    }
    let destination = exact_child(&preferences, "locale.json")?;
    if destination.exists() {
        let metadata =
            std::fs::symlink_metadata(&destination).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata_is_unsafe_link(&metadata) {
            return Err("Teti locale preference target is unsafe.".to_string());
        }
    }
    let temporary = exact_child(&preferences, "locale.json.tmp")?;
    if temporary.exists() {
        let metadata = std::fs::symlink_metadata(&temporary).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata_is_unsafe_link(&metadata) {
            return Err("Teti locale preference temporary file is unsafe.".to_string());
        }
        std::fs::remove_file(&temporary).map_err(|error| error.to_string())?;
    }
    let record = LocalePreferenceRecord {
        schema_version: 1,
        preference: preference.to_string(),
    };
    let bytes = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    drop(file);
    if destination.exists() {
        std::fs::remove_file(&destination).map_err(|error| error.to_string())?;
    }
    std::fs::rename(&temporary, &destination).map_err(|error| error.to_string())
}

pub fn validate_profile_reset_target(app: &AppHandle, target: &Path) -> Result<(), String> {
    let expected = paths(app)?.profile_root;
    validate_exact_profile_reset_target(&expected, target)
}

#[cfg(target_os = "windows")]
fn prepare_profile_security(profile_root: &Path) -> Result<ProfileSecurity, String> {
    windows_security::ensure_protected_profile_acl(profile_root)?;
    Ok(ProfileSecurity::ProtectedAcl)
}

#[cfg(target_os = "windows")]
fn inspect_profile_security(profile_root: &Path) -> Result<ProfileSecurity, String> {
    windows_security::verify_protected_profile_acl(profile_root)?;
    Ok(ProfileSecurity::ProtectedAcl)
}

#[cfg(not(target_os = "windows"))]
fn prepare_profile_security(_profile_root: &Path) -> Result<ProfileSecurity, String> {
    Ok(ProfileSecurity::PlatformDefault)
}

#[cfg(not(target_os = "windows"))]
fn inspect_profile_security(_profile_root: &Path) -> Result<ProfileSecurity, String> {
    Ok(ProfileSecurity::PlatformDefault)
}

#[tauri::command]
pub fn desktop_platform_info() -> DesktopPlatformInfo {
    info()
}

const fn current_platform() -> DesktopPlatform {
    #[cfg(target_os = "macos")]
    {
        DesktopPlatform::Macos
    }
    #[cfg(target_os = "windows")]
    {
        DesktopPlatform::Windows
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        DesktopPlatform::Other
    }
}

const fn current_architecture() -> DesktopArchitecture {
    #[cfg(target_arch = "aarch64")]
    {
        DesktopArchitecture::Arm64
    }
    #[cfg(target_arch = "x86_64")]
    {
        DesktopArchitecture::X64
    }
    #[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
    {
        DesktopArchitecture::Other
    }
}

fn macos_paths(home: &Path) -> Result<DesktopPlatformPaths, String> {
    validate_absolute_root(home, "home")?;
    Ok(DesktopPlatformPaths {
        profile_root: exact_child(home, ".teti")?,
        log_dir: exact_child(
            &exact_child(&exact_child(home, "Library")?, "Logs")?,
            "Teti",
        )?,
    })
}

fn local_data_paths(local_data: &Path) -> Result<DesktopPlatformPaths, String> {
    validate_absolute_root(local_data, "local app data")?;
    Ok(DesktopPlatformPaths {
        profile_root: exact_child(local_data, "profile")?,
        log_dir: exact_child(local_data, "logs")?,
    })
}

fn validate_absolute_root(root: &Path, label: &str) -> Result<(), String> {
    if !root.is_absolute() || root.parent().is_none() {
        return Err(format!("Refusing to use an unsafe Teti {label} root."));
    }
    Ok(())
}

fn exact_child(parent: &Path, child: &str) -> Result<PathBuf, String> {
    let path = parent.join(child);
    if path.parent() != Some(parent)
        || path.file_name().and_then(|name| name.to_str()) != Some(child)
    {
        return Err("Refusing to resolve an unsafe Teti platform path.".to_string());
    }
    Ok(path)
}

fn artifact_image_root_for_profile(profile_root: &Path) -> Result<PathBuf, String> {
    validate_absolute_root(profile_root, "profile")?;
    exact_child(
        &exact_child(&exact_child(profile_root, "store-v2")?, "task-attachments")?,
        "artifact",
    )
}

fn locale_preference_path_for_profile(profile_root: &Path) -> Result<PathBuf, String> {
    validate_absolute_root(profile_root, "profile")?;
    exact_child(&exact_child(profile_root, "preferences")?, "locale.json")
}

fn validate_locale_preference(value: &str) -> Result<(), String> {
    if matches!(value, "auto" | "zh-Hans" | "en") {
        Ok(())
    } else {
        Err("Unsupported Teti locale preference.".to_string())
    }
}

fn validate_locale_preference_record(record: &LocalePreferenceRecord) -> Result<(), String> {
    if record.schema_version != 1 {
        return Err("Unsupported Teti locale preference schema.".to_string());
    }
    validate_locale_preference(&record.preference)
}

fn validate_exact_profile_reset_target(expected: &Path, target: &Path) -> Result<(), String> {
    validate_absolute_root(expected, "profile")?;
    if target != expected || target.parent() != expected.parent() || target.file_name().is_none() {
        return Err(
            "Refusing to reset a path other than the exact local Teti Profile.".to_string(),
        );
    }
    let parent = target
        .parent()
        .ok_or_else(|| "Refusing to reset a Teti Profile without a parent.".to_string())?;
    if let Ok(metadata) = std::fs::symlink_metadata(parent) {
        if !metadata.is_dir() || metadata_is_unsafe_link(&metadata) {
            return Err("Refusing to reset a Teti Profile below an unsafe parent.".to_string());
        }
    }
    if target.exists() {
        validate_profile_root_entry(target)?;
    }
    Ok(())
}

fn validate_profile_root_entry(profile_root: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(profile_root).map_err(|error| error.to_string())?;
    if !metadata.is_dir() || metadata_is_unsafe_link(&metadata) {
        return Err("Refusing to use a linked or reparse-point Teti Profile root.".to_string());
    }
    Ok(())
}

fn metadata_is_unsafe_link(metadata: &std::fs::Metadata) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn macos_paths_preserve_the_existing_profile_and_log_locations() {
        let paths = macos_paths(Path::new("/Users/teti-test")).unwrap();
        assert_eq!(paths.profile_root, Path::new("/Users/teti-test/.teti"));
        assert_eq!(
            paths.log_dir,
            Path::new("/Users/teti-test/Library/Logs/Teti")
        );
    }

    #[test]
    fn windows_style_paths_stay_below_the_app_local_data_root() {
        let root = if cfg!(target_os = "windows") {
            Path::new("C:/Users/teti/AppData/Local/bot.teti.app")
        } else {
            Path::new("/Users/teti/AppData/Local/bot.teti.app")
        };
        let paths = local_data_paths(root).unwrap();
        assert_eq!(paths.profile_root, root.join("profile"));
        assert_eq!(paths.log_dir, root.join("logs"));
        assert_eq!(
            artifact_image_root_for_profile(&paths.profile_root).unwrap(),
            root.join("profile/store-v2/task-attachments/artifact")
        );
    }

    #[test]
    fn relative_platform_roots_are_rejected() {
        assert!(macos_paths(Path::new("relative-home")).is_err());
        assert!(local_data_paths(Path::new("relative-local-data")).is_err());
    }

    #[test]
    fn platform_info_matches_the_compile_target() {
        let info = info();
        #[cfg(target_os = "macos")]
        assert_eq!(info.platform, DesktopPlatform::Macos);
        #[cfg(target_os = "windows")]
        assert_eq!(info.platform, DesktopPlatform::Windows);
    }

    #[test]
    fn windows_runtime_is_bundled_in_m2() {
        let runtime = match DesktopPlatform::Windows {
            DesktopPlatform::Macos | DesktopPlatform::Windows => LifecycleRuntime::Bundled,
            DesktopPlatform::Other => LifecycleRuntime::Mock,
        };
        assert_eq!(runtime, LifecycleRuntime::Bundled);
    }

    #[test]
    fn profile_reset_accepts_only_the_exact_resolved_profile() {
        let root = if cfg!(target_os = "windows") {
            Path::new("C:/Users/teti/AppData/Local/bot.teti.app")
        } else {
            Path::new("/Users/teti/AppData/Local/bot.teti.app")
        };
        let profile = root.join("profile");
        assert!(validate_exact_profile_reset_target(&profile, &profile).is_ok());
        assert!(validate_exact_profile_reset_target(&profile, root).is_err());
        assert!(validate_exact_profile_reset_target(&profile, &profile.join("store-v2")).is_err());
    }

    #[test]
    fn locale_preference_is_bounded_below_the_profile() {
        let root = if cfg!(target_os = "windows") {
            Path::new("C:/Users/teti/AppData/Local/bot.teti.app/profile")
        } else {
            Path::new("/Users/teti/AppData/Local/bot.teti.app/profile")
        };
        assert_eq!(
            locale_preference_path_for_profile(root).unwrap(),
            root.join("preferences/locale.json")
        );
        assert!(validate_locale_preference("auto").is_ok());
        assert!(validate_locale_preference("zh-Hans").is_ok());
        assert!(validate_locale_preference("en").is_ok());
        assert!(validate_locale_preference("zh-TW").is_err());
    }
}
