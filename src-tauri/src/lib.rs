use std::io::{Seek, SeekFrom, Write};

/// Decodes the `encodeURIComponent` form the front end uses to send a path in a header (header
/// values must be ASCII, Windows paths needn't be).
fn percent_decode(value: &str) -> Result<String, String> {
  let bytes = value.as_bytes();
  let mut out = Vec::with_capacity(bytes.len());
  let mut i = 0;
  while i < bytes.len() {
    if bytes[i] == b'%' && i + 2 < bytes.len() {
      let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).map_err(|e| e.to_string())?;
      out.push(u8::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
      i += 3;
    } else {
      out.push(bytes[i]);
      i += 1;
    }
  }
  String::from_utf8(out).map_err(|e| e.to_string())
}

/// Writes the raw request body into an existing file at a byte offset.
///
/// plugin-fs can only write at an offset through `FileHandle.write`, which sends the bytes as a JSON
/// array of numbers — unusable for the multi-MB chunks the ISO Install tab moves. This takes them
/// as a raw body, like plugin-fs's own `write_file`, with the path and offset in headers.
#[tauri::command]
async fn write_at(request: tauri::ipc::Request<'_>) -> Result<(), String> {
  let header = |name: &str| -> Result<String, String> {
    request.headers().get(name).ok_or(format!("missing {name} header"))?.to_str().map(str::to_owned).map_err(|e| e.to_string())
  };
  let path = percent_decode(&header("path")?)?;
  let offset: u64 = header("offset")?.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
  let tauri::ipc::InvokeBody::Raw(data) = request.body() else {
    return Err("write_at expects a raw byte body".into());
  };
  let mut file = std::fs::OpenOptions::new().write(true).open(&path).map_err(|e| format!("{path}: {e}"))?;
  file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
  file.write_all(data).map_err(|e| format!("{path}: {e}"))?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .invoke_handler(tauri::generate_handler![write_at])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
