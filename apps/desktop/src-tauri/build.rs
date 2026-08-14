fn main() {
    println!("cargo:rerun-if-env-changed=TETI_BUILD_TYPE");
    tauri_build::build();
}
