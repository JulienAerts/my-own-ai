mod desktop;
mod files;
mod llama;
mod mcp;
mod python;
mod sdcpp;
mod whisper;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_http::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_opener::init())
    .plugin(desktop::shortcut_plugin())
    .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--minimized"])))
    .on_window_event(desktop::on_window_event)
    .manage(llama::LlamaState::default())
    .manage(mcp::McpState::default())
    .manage(whisper::WhisperState::default())
    .invoke_handler(tauri::generate_handler![
      llama::gpu_info,
      llama::llama_status,
      llama::install_engine,
      llama::download_model,
      llama::cancel_download,
      llama::delete_model,
      llama::start_llama,
      llama::stop_llama,
      llama::llama_log,
      mcp::mcp_start,
      mcp::mcp_send,
      mcp::mcp_stop,
      mcp::mcp_stderr,
      files::fs_list,
      files::fs_read,
      files::fs_write,
      files::fs_exists,
      files::save_as,
      whisper::whisper_installed,
      whisper::install_whisper,
      whisper::remove_whisper,
      whisper::start_whisper,
      sdcpp::sd_installed,
      sdcpp::install_sd,
      sdcpp::gpu_free_mb,
      sdcpp::generate_image,
      desktop::set_keep_in_tray,
      python::python_info,
      python::run_python,
    ])
    .setup(|app| {
      desktop::setup(app)?;
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // Never leave llama-server running (and holding GPU memory) after the app closes.
      if let tauri::RunEvent::Exit = event {
        app.state::<llama::LlamaState>().stop();
        app.state::<mcp::McpState>().stop_all();
        app.state::<whisper::WhisperState>().stop();
      }
    });
}
