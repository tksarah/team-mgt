use calamine::{open_workbook_auto, Data, Reader};
use chrono::Utc;
use rusqlite::{params, Connection};
use rust_xlsxwriter::{Workbook, XlsxError};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State, WindowEvent};
use thiserror::Error;

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE},
    System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
};

#[derive(Debug, Error)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sql(#[from] rusqlite::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Xlsx(#[from] XlsxError),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

type AppResult<T> = Result<T, AppError>;

#[derive(Debug)]
struct AppStorage {
    database_path: PathBuf,
    lock_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MasterItem {
    id: String,
    kind: String,
    name: String,
    color: String,
    sort_order: i64,
    enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    name: String,
    category_id: String,
    assignee_ids: Vec<String>,
    status_id: String,
    priority_id: String,
    start_date: String,
    due_date: String,
    dependency_task_ids: Vec<String>,
    notes: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppData {
    database_path: String,
    tasks: Vec<Task>,
    masters: Vec<MasterItem>,
    lock_state: Option<LockState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockState {
    owner: String,
    machine: String,
    acquired_at: String,
    token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportReport {
    imported_tasks: usize,
    imported_masters: usize,
    errors: Vec<String>,
}

#[derive(Debug, Clone)]
struct RawTaskImport {
    row_no: usize,
    id: String,
    name: String,
    category_name: String,
    category_id: String,
    assignee_names: String,
    assignee_ids: String,
    status_name: String,
    status_id: String,
    dependency_names: String,
    dependency_ids: String,
    priority_name: String,
    priority_id: String,
    start_date: String,
    due_date: String,
    notes: String,
}

#[derive(Debug, Clone)]
struct PendingTaskImport {
    row_no: usize,
    task: Task,
}

pub fn run() {
    let database_path = default_database_path();
    let state = Mutex::new(AppStorage {
        database_path,
        lock_token: None,
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            load_app_data,
            set_database_path,
            acquire_lock,
            release_lock,
            save_task,
            delete_task,
            save_master,
            delete_master,
            export_excel,
            import_excel
        ])
        .setup(|app| {
            let state = app.state::<Mutex<AppStorage>>();
            let storage = state.lock().map_err(|_| "failed to lock app state")?;
            ensure_database(&storage.database_path).map_err(|err| err.to_string())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, WindowEvent::CloseRequested { .. }) {
                let state = window.state::<Mutex<AppStorage>>();
                {
                    if let Ok(mut storage) = state.lock() {
                        let _ = release_owned_lock(&mut storage);
                    }
                };
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[tauri::command]
fn load_app_data(state: State<'_, Mutex<AppStorage>>) -> AppResult<AppData> {
    let storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    ensure_database(&storage.database_path)?;
    read_app_data_for_storage(&storage)
}

#[tauri::command]
fn set_database_path(path: String, state: State<'_, Mutex<AppStorage>>) -> AppResult<AppData> {
    let next_path = normalize_database_path(path)?;
    ensure_database(&next_path)?;
    let mut storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    storage.database_path = next_path;
    storage.lock_token = None;
    read_app_data_for_storage(&storage)
}

#[tauri::command]
fn acquire_lock(owner: String, state: State<'_, Mutex<AppStorage>>) -> AppResult<LockState> {
    let mut storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    let owner = owner.trim();
    if owner.is_empty() {
        return Err(AppError::Message("利用者名を入力してください。".into()));
    }
    let token = format!("{}-{}", std::process::id(), now_stamp());
    let lock = LockState {
        owner: owner.to_string(),
        machine: hostname::get()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string(),
        acquired_at: Utc::now().to_rfc3339(),
        token: Some(token.clone()),
    };
    let lock_path = lock_path(&storage.database_path);
    let mut file = OpenOptions::new().write(true).create_new(true).open(&lock_path).map_err(|err| {
        if err.kind() == std::io::ErrorKind::AlreadyExists {
            AppError::Message("他の利用者が編集中です。読み取り専用で開いてください。".into())
        } else {
            AppError::Io(err)
        }
    })?;
    file.write_all(serde_json::to_string_pretty(&lock)?.as_bytes())?;
    storage.lock_token = Some(token);
    Ok(lock)
}

#[tauri::command]
fn release_lock(state: State<'_, Mutex<AppStorage>>) -> AppResult<Option<LockState>> {
    let mut storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    release_owned_lock(&mut storage)
}

#[tauri::command]
fn save_task(task: Task, state: State<'_, Mutex<AppStorage>>) -> AppResult<Task> {
    let storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    require_own_lock(&storage)?;
    validate_task(&storage.database_path, &task)?;
    let now = Utc::now().to_rfc3339();
    let mut task = task;
    if task.id.trim().is_empty() {
        task.id = new_id("task");
        task.created_at = now.clone();
    }
    task.updated_at = now;
    if task.created_at.trim().is_empty() {
        task.created_at = task.updated_at.clone();
    }

    let conn = Connection::open(&storage.database_path)?;
    conn.execute(
        "insert into tasks (id, name, category_id, assignee_ids, status_id, priority_id, start_date, due_date, dependency_task_ids, notes, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         on conflict(id) do update set
           name=excluded.name,
           category_id=excluded.category_id,
           assignee_ids=excluded.assignee_ids,
           status_id=excluded.status_id,
           priority_id=excluded.priority_id,
           start_date=excluded.start_date,
           due_date=excluded.due_date,
           dependency_task_ids=excluded.dependency_task_ids,
           notes=excluded.notes,
           updated_at=excluded.updated_at",
        params![
            task.id,
            task.name,
            task.category_id,
            serde_json::to_string(&task.assignee_ids)?,
            task.status_id,
            task.priority_id,
            task.start_date,
            task.due_date,
            serde_json::to_string(&task.dependency_task_ids)?,
            task.notes,
            task.created_at,
            task.updated_at
        ],
    )?;
    Ok(task)
}

#[tauri::command]
fn delete_task(id: String, state: State<'_, Mutex<AppStorage>>) -> AppResult<()> {
    let storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    require_own_lock(&storage)?;
    let conn = Connection::open(&storage.database_path)?;
    conn.execute("delete from tasks where id = ?1", params![id])?;
    Ok(())
}

#[tauri::command]
fn save_master(master: MasterItem, state: State<'_, Mutex<AppStorage>>) -> AppResult<MasterItem> {
    let storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    require_own_lock(&storage)?;
    let mut master = master;
    if master.id.trim().is_empty() {
        master.id = new_id(&master.kind);
    }
    if master.name.trim().is_empty() {
        return Err(AppError::Message("マスタ名を入力してください。".into()));
    }
    let conn = Connection::open(&storage.database_path)?;
    conn.execute(
        "insert into masters (id, kind, name, color, sort_order, enabled)
         values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict(id) do update set
           kind=excluded.kind,
           name=excluded.name,
           color=excluded.color,
           sort_order=excluded.sort_order,
           enabled=excluded.enabled",
        params![master.id, master.kind, master.name, master.color, master.sort_order, master.enabled],
    )?;
    Ok(master)
}

#[tauri::command]
fn delete_master(id: String, state: State<'_, Mutex<AppStorage>>) -> AppResult<()> {
    let storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    require_own_lock(&storage)?;
    let conn = Connection::open(&storage.database_path)?;
    conn.execute("delete from masters where id = ?1", params![id])?;
    Ok(())
}

#[tauri::command]
fn export_excel(path: String, state: State<'_, Mutex<AppStorage>>) -> AppResult<()> {
    let storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    let data = read_app_data(&storage.database_path)?;
    write_excel(Path::new(&path), &data.tasks, &data.masters)?;
    Ok(())
}

#[tauri::command]
fn import_excel(path: String, state: State<'_, Mutex<AppStorage>>) -> AppResult<ImportReport> {
    let storage = state.lock().map_err(|_| AppError::Message("アプリ状態を取得できません。".into()))?;
    require_own_lock(&storage)?;
    import_excel_file(Path::new(&path), &storage.database_path)
}

fn default_database_path() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")))
        .join("team-mgt.sqlite")
}

fn normalize_database_path(path: String) -> AppResult<PathBuf> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppError::Message("データファイルのパスを入力してください。".into()));
    }
    let mut path = PathBuf::from(trimmed);
    if path.extension().is_none() {
        path.push("team-mgt.sqlite");
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    Ok(path)
}

fn ensure_database(path: &Path) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "
        create table if not exists masters (
            id text primary key,
            kind text not null,
            name text not null,
            color text not null,
            sort_order integer not null,
            enabled integer not null
        );
        create table if not exists tasks (
            id text primary key,
            name text not null,
            category_id text not null,
            assignee_ids text not null,
            status_id text not null,
            priority_id text not null,
            start_date text not null,
            due_date text not null,
            dependency_task_ids text not null,
            notes text not null,
            created_at text not null,
            updated_at text not null
        );
        ",
    )?;
    seed_masters(&conn)?;
    Ok(())
}

fn seed_masters(conn: &Connection) -> AppResult<()> {
    let count: i64 = conn.query_row("select count(*) from masters", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let defaults = [
        ("category-general", "category", "一般", "#3b82f6", 10),
        ("category-improvement", "category", "改善", "#0f766e", 20),
        ("assignee-unassigned", "assignee", "未設定", "#64748b", 10),
        ("status-not-started", "status", "未着手", "#64748b", 10),
        ("status-in-progress", "status", "進行中", "#2563eb", 20),
        ("status-done", "status", "完了", "#16a34a", 30),
        ("priority-high", "priority", "高", "#dc2626", 10),
        ("priority-medium", "priority", "中", "#d97706", 20),
        ("priority-low", "priority", "低", "#16a34a", 30),
    ];
    for (id, kind, name, color, sort_order) in defaults {
        conn.execute(
            "insert into masters (id, kind, name, color, sort_order, enabled) values (?1, ?2, ?3, ?4, ?5, 1)",
            params![id, kind, name, color, sort_order],
        )?;
    }
    Ok(())
}

fn read_app_data(path: &Path) -> AppResult<AppData> {
    ensure_database(path)?;
    let conn = Connection::open(path)?;
    let mut master_stmt = conn.prepare(
        "select id, kind, name, color, sort_order, enabled from masters order by kind, sort_order, name",
    )?;
    let masters = master_stmt
        .query_map([], |row| {
            Ok(MasterItem {
                id: row.get(0)?,
                kind: row.get(1)?,
                name: row.get(2)?,
                color: row.get(3)?,
                sort_order: row.get(4)?,
                enabled: row.get::<_, i64>(5)? == 1,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    let mut task_stmt = conn.prepare(
        "select id, name, category_id, assignee_ids, status_id, priority_id, start_date, due_date, dependency_task_ids, notes, created_at, updated_at
         from tasks order by due_date, priority_id, name",
    )?;
    let tasks = task_stmt
        .query_map([], |row| {
            let assignee_json: String = row.get(3)?;
            let dependency_json: String = row.get(8)?;
            Ok(Task {
                id: row.get(0)?,
                name: row.get(1)?,
                category_id: row.get(2)?,
                assignee_ids: serde_json::from_str(&assignee_json).unwrap_or_default(),
                status_id: row.get(4)?,
                priority_id: row.get(5)?,
                start_date: row.get(6)?,
                due_date: row.get(7)?,
                dependency_task_ids: serde_json::from_str(&dependency_json).unwrap_or_default(),
                notes: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;

    Ok(AppData {
        database_path: path.to_string_lossy().to_string(),
        tasks,
        masters,
        lock_state: read_lock(path)?,
    })
}

fn read_app_data_for_storage(storage: &AppStorage) -> AppResult<AppData> {
    let mut data = read_app_data(&storage.database_path)?;
    if let Some(lock) = &mut data.lock_state {
        if lock.token.as_deref() != storage.lock_token.as_deref() {
            lock.token = None;
        }
    }
    Ok(data)
}

fn validate_task(path: &Path, task: &Task) -> AppResult<()> {
    let data = read_app_data(path)?;
    validate_task_against_tasks(&data.tasks, task)
}

fn validate_task_against_tasks(existing_tasks: &[Task], task: &Task) -> AppResult<()> {
    if task.name.trim().is_empty()
        || task.category_id.trim().is_empty()
        || task.assignee_ids.is_empty()
        || task.status_id.trim().is_empty()
        || task.priority_id.trim().is_empty()
        || task.start_date.trim().is_empty()
        || task.due_date.trim().is_empty()
    {
        return Err(AppError::Message("必須項目をすべて入力してください。".into()));
    }
    if task.dependency_task_ids.len() > 1 {
        return Err(AppError::Message("依存タスクは1件までにしてください。".into()));
    }
    if task.start_date > task.due_date {
        return Err(AppError::Message("開始日は期日以前にしてください。".into()));
    }
    if task.dependency_task_ids.iter().any(|id| id == &task.id) {
        return Err(AppError::Message("自分自身を依存タスクにはできません。".into()));
    }
    for id in &task.dependency_task_ids {
        if !existing_tasks.iter().any(|candidate| &candidate.id == id) {
            return Err(AppError::Message(format!("依存タスクが見つかりません: {id}")));
        }
    }
    ensure_no_dependency_cycle(existing_tasks, task)?;
    Ok(())
}

fn ensure_no_dependency_cycle(existing_tasks: &[Task], task: &Task) -> AppResult<()> {
    let mut dependency_map = existing_tasks
        .iter()
        .map(|candidate| (candidate.id.clone(), candidate.dependency_task_ids.clone()))
        .collect::<HashMap<_, _>>();
    dependency_map.insert(task.id.clone(), task.dependency_task_ids.clone());

    let mut task_names = existing_tasks
        .iter()
        .map(|candidate| (candidate.id.clone(), candidate.name.clone()))
        .collect::<HashMap<_, _>>();
    task_names.insert(task.id.clone(), task.name.clone());

    let mut visit_states = HashMap::new();
    let mut stack = Vec::new();

    for task_id in dependency_map.keys() {
        if visit_states.get(task_id).copied().unwrap_or(0) != 0 {
            continue;
        }
        if let Some(cycle) = detect_dependency_cycle(task_id, &dependency_map, &mut visit_states, &mut stack) {
            let labels = cycle
                .iter()
                .map(|id| task_names.get(id).cloned().unwrap_or_else(|| id.clone()))
                .collect::<Vec<_>>()
                .join(" -> ");
            return Err(AppError::Message(format!("依存タスクに循環があります: {labels}")));
        }
    }

    Ok(())
}

fn detect_dependency_cycle(
    task_id: &str,
    dependency_map: &HashMap<String, Vec<String>>,
    visit_states: &mut HashMap<String, u8>,
    stack: &mut Vec<String>,
) -> Option<Vec<String>> {
    visit_states.insert(task_id.to_string(), 1);
    stack.push(task_id.to_string());

    if let Some(dependency_ids) = dependency_map.get(task_id) {
        for dependency_id in dependency_ids {
            match visit_states.get(dependency_id).copied().unwrap_or(0) {
                0 => {
                    if let Some(cycle) = detect_dependency_cycle(dependency_id, dependency_map, visit_states, stack) {
                        return Some(cycle);
                    }
                }
                1 => {
                    if let Some(index) = stack.iter().position(|id| id == dependency_id) {
                        let mut cycle = stack[index..].to_vec();
                        cycle.push(dependency_id.clone());
                        return Some(cycle);
                    }
                    return Some(vec![task_id.to_string(), dependency_id.clone()]);
                }
                _ => {}
            }
        }
    }

    stack.pop();
    visit_states.insert(task_id.to_string(), 2);
    None
}

fn require_own_lock(storage: &AppStorage) -> AppResult<()> {
    let lock = read_lock(&storage.database_path)?;
    match (lock, &storage.lock_token) {
        (Some(lock), Some(token)) if lock.token.as_deref() == Some(token.as_str()) => Ok(()),
        (Some(_), _) => Err(AppError::Message("他の利用者が編集中のため保存できません。".into())),
        (None, _) => Err(AppError::Message("編集ロックを取得してから保存してください。".into())),
    }
}

fn release_owned_lock(storage: &mut AppStorage) -> AppResult<Option<LockState>> {
    let lock_path = lock_path(&storage.database_path);
    let existing = read_lock(&storage.database_path)?;
    if let (Some(lock), Some(token)) = (&existing, &storage.lock_token) {
        if lock.token.as_deref() == Some(token.as_str()) {
            if lock_path.exists() {
                fs::remove_file(lock_path)?;
            }
            storage.lock_token = None;
            return Ok(None);
        }
    }
    Ok(existing)
}

fn lock_path(database_path: &Path) -> PathBuf {
    database_path.with_extension("lock")
}

fn read_lock(database_path: &Path) -> AppResult<Option<LockState>> {
    let path = lock_path(database_path);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(path)?;
    let lock: LockState = serde_json::from_str(&text)?;
    if is_stale_lock(&lock) {
        fs::remove_file(lock_path(database_path))?;
        return Ok(None);
    }
    Ok(Some(lock))
}

fn is_stale_lock(lock: &LockState) -> bool {
    if lock.machine.trim().is_empty() {
        return false;
    }

    let current_machine = hostname::get()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    if !current_machine.eq_ignore_ascii_case(&lock.machine) {
        return false;
    }

    let Some(token) = lock.token.as_deref() else {
        return false;
    };
    let Some(pid) = parse_lock_pid(token) else {
        return false;
    };

    !is_process_running(pid)
}

fn parse_lock_pid(token: &str) -> Option<u32> {
    token.split_once('-')?.0.parse().ok()
}

#[cfg(target_os = "windows")]
fn is_process_running(pid: u32) -> bool {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if process.is_null() {
            return GetLastError() != ERROR_INVALID_PARAMETER;
        }

        let mut exit_code = 0;
        let result = GetExitCodeProcess(process, &mut exit_code);
        CloseHandle(process);

        if result == 0 {
            return true;
        }

        exit_code == STILL_ACTIVE as u32
    }
}

#[cfg(not(target_os = "windows"))]
fn is_process_running(_pid: u32) -> bool {
    true
}

fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", now_stamp())
}

fn now_stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

fn master_name(masters: &[MasterItem], id: &str) -> String {
    masters
        .iter()
        .find(|master| master.id == id)
        .map(|master| master.name.clone())
        .unwrap_or_else(|| id.to_string())
}

fn master_ids_by_names(masters: &[MasterItem], kind: &str, names: &str) -> Vec<String> {
    names
        .split(',')
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .filter_map(|name| {
            masters
                .iter()
                .find(|master| master.kind == kind && master.name == name)
                .map(|master| master.id.clone())
        })
        .collect()
}

fn split_csv(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

fn resolve_master_ids(masters: &[MasterItem], kind: &str, backup_ids: &str, backup_names: &str) -> Vec<String> {
    let explicit_ids = split_csv(backup_ids);
    if !explicit_ids.is_empty() {
        return explicit_ids;
    }
    master_ids_by_names(masters, kind, backup_names)
}

fn resolve_dependency_ids(
    backup_ids: &str,
    backup_names: &str,
    imported_name_to_id: &HashMap<String, String>,
    existing_name_to_id: &HashMap<String, String>,
) -> Vec<String> {
    let explicit_ids = split_csv(backup_ids);
    if !explicit_ids.is_empty() {
        return explicit_ids;
    }

    split_csv(backup_names)
        .into_iter()
        .filter_map(|name| {
            imported_name_to_id
                .get(&name)
                .cloned()
                .or_else(|| existing_name_to_id.get(&name).cloned())
        })
        .collect()
}

fn upsert_task_record(conn: &Connection, task: &Task) -> AppResult<()> {
    conn.execute(
        "insert into tasks (id, name, category_id, assignee_ids, status_id, priority_id, start_date, due_date, dependency_task_ids, notes, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         on conflict(id) do update set name=excluded.name, category_id=excluded.category_id, assignee_ids=excluded.assignee_ids, status_id=excluded.status_id, priority_id=excluded.priority_id, start_date=excluded.start_date, due_date=excluded.due_date, dependency_task_ids=excluded.dependency_task_ids, notes=excluded.notes, updated_at=excluded.updated_at",
        params![
            task.id,
            task.name,
            task.category_id,
            serde_json::to_string(&task.assignee_ids)?,
            task.status_id,
            task.priority_id,
            task.start_date,
            task.due_date,
            serde_json::to_string(&task.dependency_task_ids)?,
            task.notes,
            task.created_at,
            task.updated_at
        ],
    )?;
    Ok(())
}

fn write_excel(path: &Path, tasks: &[Task], masters: &[MasterItem]) -> AppResult<()> {
    let mut workbook = Workbook::new();
    let task_sheet = workbook.add_worksheet();
    task_sheet.set_name("タスク")?;
    let headers = [
        "ID",
        "タスク名",
        "カテゴリ",
        "カテゴリID",
        "担当者",
        "担当者ID",
        "ステータス",
        "ステータスID",
        "依存タスク",
        "依存タスクID",
        "優先度",
        "優先度ID",
        "開始日",
        "期日",
        "メモ"
    ];
    for (col, header) in headers.iter().enumerate() {
        task_sheet.write_string(0, col as u16, *header)?;
    }
    for (idx, task) in tasks.iter().enumerate() {
        let row = (idx + 1) as u32;
        let assignees = task
            .assignee_ids
            .iter()
            .map(|id| master_name(masters, id))
            .collect::<Vec<_>>()
            .join(", ");
        let dependencies = task
            .dependency_task_ids
            .iter()
            .filter_map(|id| tasks.iter().find(|candidate| &candidate.id == id))
            .map(|task| task.name.clone())
            .collect::<Vec<_>>()
            .join(", ");
        let dependency_ids = task.dependency_task_ids.join(", ");
        let assignee_ids = task.assignee_ids.join(", ");
        task_sheet.write_string(row, 0, &task.id)?;
        task_sheet.write_string(row, 1, &task.name)?;
        task_sheet.write_string(row, 2, master_name(masters, &task.category_id))?;
        task_sheet.write_string(row, 3, &task.category_id)?;
        task_sheet.write_string(row, 4, assignees)?;
        task_sheet.write_string(row, 5, assignee_ids)?;
        task_sheet.write_string(row, 6, master_name(masters, &task.status_id))?;
        task_sheet.write_string(row, 7, &task.status_id)?;
        task_sheet.write_string(row, 8, dependencies)?;
        task_sheet.write_string(row, 9, dependency_ids)?;
        task_sheet.write_string(row, 10, master_name(masters, &task.priority_id))?;
        task_sheet.write_string(row, 11, &task.priority_id)?;
        task_sheet.write_string(row, 12, &task.start_date)?;
        task_sheet.write_string(row, 13, &task.due_date)?;
        task_sheet.write_string(row, 14, &task.notes)?;
    }

    let master_sheet = workbook.add_worksheet();
    master_sheet.set_name("マスタ")?;
    let master_headers = ["ID", "種類", "名前", "色", "並び順", "有効"];
    for (col, header) in master_headers.iter().enumerate() {
        master_sheet.write_string(0, col as u16, *header)?;
    }
    for (idx, master) in masters.iter().enumerate() {
        let row = (idx + 1) as u32;
        master_sheet.write_string(row, 0, &master.id)?;
        master_sheet.write_string(row, 1, &master.kind)?;
        master_sheet.write_string(row, 2, &master.name)?;
        master_sheet.write_string(row, 3, &master.color)?;
        master_sheet.write_number(row, 4, master.sort_order as f64)?;
        master_sheet.write_boolean(row, 5, master.enabled)?;
    }
    workbook.save(path)?;
    Ok(())
}

fn import_excel_file(path: &Path, database_path: &Path) -> AppResult<ImportReport> {
    let mut workbook = open_workbook_auto(path).map_err(|err| AppError::Message(err.to_string()))?;
    let mut errors = Vec::new();
    let mut imported_masters = 0;
    let mut imported_tasks = 0;

    let conn = Connection::open(database_path)?;
    if let Ok(range) = workbook.worksheet_range("マスタ") {
        for (idx, row) in range.rows().enumerate().skip(1) {
            let id = cell(row, 0).unwrap_or_else(|| new_id("master"));
            let kind = cell(row, 1).unwrap_or_default();
            let name = cell(row, 2).unwrap_or_default();
            let color = cell(row, 3).unwrap_or_else(|| "#64748b".into());
            let sort_order = cell(row, 4).and_then(|value| value.parse::<i64>().ok()).unwrap_or(idx as i64 * 10);
            let enabled = cell(row, 5).map(|value| value != "false" && value != "0" && value != "無効").unwrap_or(true);
            if kind.is_empty() || name.is_empty() {
                errors.push(format!("マスタ {} 行目: 種類と名前は必須です。", idx + 1));
                continue;
            }
            conn.execute(
                "insert into masters (id, kind, name, color, sort_order, enabled)
                 values (?1, ?2, ?3, ?4, ?5, ?6)
                 on conflict(id) do update set kind=excluded.kind, name=excluded.name, color=excluded.color, sort_order=excluded.sort_order, enabled=excluded.enabled",
                params![id, kind, name, color, sort_order, enabled],
            )?;
            imported_masters += 1;
        }
    }

    let data = read_app_data(database_path)?;
    if let Ok(range) = workbook.worksheet_range("タスク") {
        let raw_tasks = range
            .rows()
            .enumerate()
            .skip(1)
            .map(|(idx, row)| RawTaskImport {
                row_no: idx + 1,
                id: cell(row, 0).unwrap_or_else(|| new_id("task")),
                name: cell(row, 1).unwrap_or_default(),
                category_name: cell(row, 2).unwrap_or_default(),
                category_id: cell(row, 3).unwrap_or_default(),
                assignee_names: cell(row, 4).unwrap_or_default(),
                assignee_ids: cell(row, 5).unwrap_or_default(),
                status_name: cell(row, 6).unwrap_or_default(),
                status_id: cell(row, 7).unwrap_or_default(),
                dependency_names: cell(row, 8).unwrap_or_default(),
                dependency_ids: cell(row, 9).unwrap_or_default(),
                priority_name: cell(row, 10).unwrap_or_default(),
                priority_id: cell(row, 11).unwrap_or_default(),
                start_date: cell(row, 12).unwrap_or_default(),
                due_date: cell(row, 13).unwrap_or_default(),
                notes: cell(row, 14).unwrap_or_else(|| cell(row, 9).unwrap_or_default()),
            })
            .collect::<Vec<_>>();

        let imported_name_to_id = raw_tasks
            .iter()
            .filter(|row| !row.name.trim().is_empty())
            .map(|row| (row.name.clone(), row.id.clone()))
            .collect::<HashMap<_, _>>();
        let existing_name_to_id = data
            .tasks
            .iter()
            .map(|task| (task.name.clone(), task.id.clone()))
            .collect::<HashMap<_, _>>();

        let mut pending_tasks = raw_tasks
            .into_iter()
            .map(|row| {
                let category_id = resolve_master_ids(&data.masters, "category", &row.category_id, &row.category_name)
                    .into_iter()
                    .next()
                    .unwrap_or_default();
                let assignee_ids = resolve_master_ids(&data.masters, "assignee", &row.assignee_ids, &row.assignee_names);
                let status_id = resolve_master_ids(&data.masters, "status", &row.status_id, &row.status_name)
                    .into_iter()
                    .next()
                    .unwrap_or_default();
                let priority_id = resolve_master_ids(&data.masters, "priority", &row.priority_id, &row.priority_name)
                    .into_iter()
                    .next()
                    .unwrap_or_default();
                let dependency_task_ids = resolve_dependency_ids(
                    &row.dependency_ids,
                    &row.dependency_names,
                    &imported_name_to_id,
                    &existing_name_to_id,
                );

                PendingTaskImport {
                    row_no: row.row_no,
                    task: Task {
                        id: row.id,
                        name: row.name,
                        category_id,
                        assignee_ids,
                        status_id,
                        priority_id,
                        start_date: row.start_date,
                        due_date: row.due_date,
                        dependency_task_ids,
                        notes: row.notes,
                        created_at: Utc::now().to_rfc3339(),
                        updated_at: Utc::now().to_rfc3339(),
                    },
                }
            })
            .collect::<Vec<_>>();

        let mut available_tasks = data.tasks.clone();
        while !pending_tasks.is_empty() {
            let available_ids = available_tasks
                .iter()
                .map(|task| task.id.clone())
                .collect::<HashSet<_>>();
            let mut next_pending = Vec::new();
            let mut progressed = false;

            for pending in pending_tasks.into_iter() {
                if pending
                    .task
                    .dependency_task_ids
                    .iter()
                    .any(|id| !available_ids.contains(id) && id != &pending.task.id)
                {
                    next_pending.push(pending);
                    continue;
                }

                let validation_tasks = available_tasks
                    .iter()
                    .filter(|task| task.id != pending.task.id)
                    .cloned()
                    .collect::<Vec<_>>();
                if let Err(err) = validate_task_against_tasks(&validation_tasks, &pending.task) {
                    errors.push(format!("タスク {} 行目: {err}", pending.row_no));
                    continue;
                }

                upsert_task_record(&conn, &pending.task)?;
                available_tasks.retain(|task| task.id != pending.task.id);
                available_tasks.push(pending.task);
                imported_tasks += 1;
                progressed = true;
            }

            if next_pending.is_empty() {
                break;
            }

            if !progressed {
                for pending in next_pending {
                    let missing = pending
                        .task
                        .dependency_task_ids
                        .iter()
                        .filter(|id| !available_tasks.iter().any(|task| &task.id == *id))
                        .cloned()
                        .collect::<Vec<_>>();
                    if missing.is_empty() {
                        errors.push(format!("タスク {} 行目: 依存タスクの循環または不整合を解決できませんでした。", pending.row_no));
                    } else {
                        errors.push(format!("タスク {} 行目: 依存タスクを解決できません: {}", pending.row_no, missing.join(", ")));
                    }
                }
                break;
            }

            pending_tasks = next_pending;
        }
    } else {
        errors.push("タスク シートが見つかりません。".into());
    }

    Ok(ImportReport {
        imported_tasks,
        imported_masters,
        errors,
    })
}

fn cell(row: &[Data], index: usize) -> Option<String> {
    row.get(index).map(|value| match value {
        Data::String(value) => value.trim().to_string(),
        Data::Float(value) => {
            if value.fract() == 0.0 {
                format!("{value:.0}")
            } else {
                value.to_string()
            }
        }
        Data::Int(value) => value.to_string(),
        Data::Bool(value) => value.to_string(),
        Data::Empty => String::new(),
        _ => value.to_string(),
    })
}
