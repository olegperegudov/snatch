mod db;
mod downloader;
mod queue;
mod server;

use server::{AppState, Settings, db_path, settings_path, start_server};
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

pub fn run() {
    eprintln!("[Snatch] Companion v{} starting", env!("CARGO_PKG_VERSION"));
    // Init DB
    let db = Arc::new(db::Db::new(&db_path()));
    db.recover_interrupted();

    // Load settings
    let settings = Settings::load(&settings_path());
    let max_concurrent = settings.max_concurrent;

    // Build shared state
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    let state = Arc::new(AppState {
        queue: queue::DownloadQueue::new(max_concurrent),
        db: db.clone(),
        settings: tokio::sync::Mutex::new(settings),
        last_request: Arc::new(AtomicU64::new(now)),
    });

    // Load interrupted downloads from DB into queue
    {
        let paused = db.get_by_status(&["paused", "pending"]);
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            for row in paused {
                let id = row.id.clone();
                state.queue.add(
                    row.id,
                    row.video_url.unwrap_or_default(),
                    row.page_url,
                    row.title.unwrap_or_default(),
                ).await;
                let mut items = state.queue.items.lock().await;
                if let Some(item) = items.get_mut(&id) {
                    item.status = queue::Status::Paused;
                }
            }
        });
    }

    // Start HTTP server on background thread
    let server_state = state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(start_server(server_state));
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Tray menu
            let show_i = MenuItem::with_id(app, "show", "Show Snatch", true, None::<&str>)?;
            let stop_i = MenuItem::with_id(app, "stop", "Stop Snatch", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &stop_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/icon.png"))
                .menu(&menu)
                .tooltip("Snatch — running on :9111")
                .on_menu_event(|app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(win) = app.get_webview_window("main") {
                                win.show().ok();
                                win.set_focus().ok();
                            }
                        }
                        "stop" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            if win.is_visible().unwrap_or(false) {
                                win.hide().ok();
                            } else {
                                win.show().ok();
                                win.set_focus().ok();
                            }
                        }
                    }
                })
                .build(app)?;

            // Show window after setup
            if let Some(win) = app.get_webview_window("main") {
                win.show().ok();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
